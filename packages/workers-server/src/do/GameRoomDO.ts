/**
 * GameRoomDO — Durable Object for a single live game.
 *
 * State lives in transactional DO storage. Turn deadlines use DO alarms.
 * All real-time updates (both players and browser spectators) use hibernatable
 * WebSockets tagged by role so the right view goes to the right connection.
 *
 * HTTP routes (sub-path, forwarded from the main Worker):
 *   POST /          — create game { gameType, config, playerIds, handleMap, teamMap }
 *   POST /action    — apply action { action }. Identity from X-Player-Id
 *                     header; missing header = system action (null).
 *   POST /tool      — plugin tool call { relay }. Same identity rule.
 *   GET  /state     — fog-filtered state for the X-Player-Id header;
 *                     missing = spectator view. Query params and bodies
 *                     are never trusted for identity.
 *   GET  /result    — Merkle root + outcome (only when finished)
 *   GET  /spectator — current delayed spectator view (HTTP snapshot, no WS)
 *   GET  /bundle   — full action bundle for verification (only when finished)
 *
 * WebSocket routes (forwarded from main Worker after auth):
 *   WS / (no X-Player-Id header)   — spectator: delayed view, no auth required
 *   WS / (X-Player-Id: <playerId>) — player: real-time fog-filtered view, auth
 *                                    validated by Worker before forwarding
 *
 * On each state change the DO pushes:
 *   - spectator tag: delayed spectator view → browser watchers
 *   - <playerId> tag: fog-filtered view → that player's CLI connection
 */

import { DurableObject } from 'cloudflare:workers';
import type {
  CoordinationGame,
  MerkleLeafData,
  RelayEnvelope,
  RelayScope,
} from '@coordination-games/engine';
import { buildActionMerkleTree, getGame, validateChatScope } from '@coordination-games/engine';
import { type AlarmEntry, StorageAlarmMux } from '../chain/alarm-multiplexer.js';
import { SETTLEMENT_ALARM_KIND } from '../chain/SettlementStateMachine.js';
import type { Env } from '../env.js';
import {
  type Capabilities,
  NamespacedStorage,
  type SpectatorViewer,
} from '../plugins/capabilities.js';
import { DOStorageRelayClient } from '../plugins/relay-client.js';
import { ServerPluginRuntime } from '../plugins/runtime.js';
import { createSettlementPlugin, SETTLEMENT_PLUGIN_ID } from '../plugins/settlement/index.js';
import { buildSpectatorPayload, type SpectatorPayload } from '../plugins/spectator-payload.js';
import { resolveGameId } from './resolve-gameid.js';
import { computePublicSnapshotIndex } from './spectator-delay.js';

// Side-effect imports: each calls registerGame() on module load
import '@coordination-games/game-ctl';
import '@coordination-games/game-oathbreaker';
// Phase 4.2 + 5.1: importing basic-chat (a) self-registers the chat relay
// schema in the engine's relay-registry so `DOStorageRelayClient.publish`
// accepts chat envelopes, and (b) gives us `CHAT_RELAY_TYPE` so this DO
// can dispatch by relay type without spelling the literal string.
import { CHAT_RELAY_TYPE } from '@coordination-games/plugin-chat';

// ---------------------------------------------------------------------------
// WS tags
// ---------------------------------------------------------------------------

const TAG_SPECTATOR = 'spectator';
// Player connections are tagged with their playerId string directly.

// ---------------------------------------------------------------------------
// Storage types
// ---------------------------------------------------------------------------

interface GameMeta {
  gameId: string;
  gameType: string;
  playerIds: string[];
  handleMap: Record<string, string>; // playerId → display handle
  /**
   * playerId → team identifier. For team games this is the team id (e.g.
   * CtL's 'A' / 'B'). For free-for-all games it's the playerId itself
   * (no `'FFA'` sentinel; per `CoordinationGame.getTeamForPlayer`).
   */
  teamMap: Record<string, string>;
  createdAt: string;
  finished: boolean;
  /**
   * Spectator delay (progress ticks) frozen at game creation so deploys
   * never retroactively change visibility for in-flight games.
   */
  spectatorDelay: number;
}

interface ProgressState {
  counter: number;
}

interface ActionEntry {
  playerId: string | null;
  action: unknown;
}

interface DeadlineEntry {
  action: unknown;
  deadlineMs: number;
}

/**
 * Translate the legacy wire-format `scope` string ('all' | 'team' | <handle>)
 * coming in on a /tool POST into the canonical `RelayScope` discriminated
 * union. `'team'` resolves to the sender's team via `teamMap`. For FFA games
 * the team id IS the playerId, so a 'team' scope from an FFA player produces
 * a single-recipient team scope (effectively a self-DM, which is correct).
 */
function resolveWireScope(
  scope: string | undefined,
  sender: string,
  teamMap: Record<string, string>,
): RelayScope {
  if (!scope || scope === 'all') return { kind: 'all' };
  if (scope === 'team') {
    const t = teamMap[sender];
    if (t) return { kind: 'team', teamId: t };
    return { kind: 'all' };
  }
  return { kind: 'dm', recipientHandle: scope };
}

// ---------------------------------------------------------------------------
// GameRoomDO
// ---------------------------------------------------------------------------

export class GameRoomDO extends DurableObject<Env> {
  // In-memory cache — valid for the lifetime of this DO instance
  private _loaded = false;
  private _meta: GameMeta | null = null;
  private _plugin: CoordinationGame<unknown, unknown, unknown, unknown> | null = null;
  private _state: unknown = null;
  private _actionLog: ActionEntry[] = [];
  private _progress: ProgressState = { counter: 0 };
  /**
   * Monotonic counter bumped on every viewer-visible state mutation
   * (action applied, game created, force-finished, meta-finished flipped).
   * Does NOT bump on chat/relay publishes. Clients echo the last-seen
   * value as `?knownStateVersion=N`; when it matches, the server omits
   * the `state` block on the response and the client reuses its cache.
   */
  private _stateVersion = 0;
  private _relayClient: DOStorageRelayClient | null = null;
  private _spectatorSnapshots: unknown[] = []; // spectator view at each progress point
  // Last publicSnapshotIndex() value pushed to spectator WS sockets —
  // broadcastUpdates skips the push when the index hasn't advanced.
  // Persisted to DO storage under key 'lastSpectatorIdx' (Phase 7.3) so
  // it survives DO eviction; without persistence a hibernated DO that
  // wakes up would always re-broadcast the latest index even when
  // spectators already have it.
  private _lastSpectatorIdx: number | null = null;
  /**
   * Phase 7.1 — relay-tip cursor used by `broadcastUpdates` to send only
   * envelopes published since the last spectator bump. In-memory only:
   * a fresh DO wake-up emits a full snapshot to whichever spectators
   * happen to reconnect, then resumes incremental broadcasts. (Persisting
   * this would write-amp without buying meaningful bandwidth savings —
   * spectators reconnecting after a hibernation already need the full
   * payload anyway.)
   */
  private _lastBroadcastRelayIdx: number = 0;

  /**
   * Phase 3.2 — alarm multiplexer. The DO has one alarm slot but two
   * consumers (turn deadlines + settlement state machine). Every consumer
   * goes through this; `alarm()` pops due entries and dispatches by `kind`.
   */
  private _alarmMux: StorageAlarmMux | null = null;

  private getAlarmMux(): StorageAlarmMux {
    if (!this._alarmMux) {
      this._alarmMux = new StorageAlarmMux(this.ctx.storage);
    }
    return this._alarmMux;
  }

  /**
   * Per-DO `ServerPluginRuntime` (Phase 5.3). Hosts the settlement plugin
   * today; future per-game plugins land here. Worker-level plugins (ELO)
   * live in a different runtime instance.
   */
  private _pluginRuntime: Promise<ServerPluginRuntime> | null = null;
  private getPluginRuntime(): Promise<ServerPluginRuntime> {
    if (!this._pluginRuntime) {
      const caps: Capabilities = {
        storage: new NamespacedStorage(this.ctx.storage, SETTLEMENT_PLUGIN_ID),
        relay: this.getRelayClient(),
        alarms: {
          scheduleAt: (when, kind, payload) => this.scheduleAlarmEntry({ when, kind, payload }),
          cancel: (kind) => this.cancelAlarmKind(kind),
        },
        d1: this.env.DB,
        chain: this.lazyCreateRelay(),
      };
      const runtime = new ServerPluginRuntime(caps, {
        gameId: this._meta?.gameId ?? this.ctx.id.name ?? '__unknown__',
      });
      this._pluginRuntime = runtime.register(createSettlementPlugin()).then(() => runtime);
    }
    return this._pluginRuntime;
  }

  /**
   * Phase 5.4 — fan a freshly-published envelope out to every plugin's
   * `handleRelay`. Today no registered plugin implements `handleRelay`
   * (settlement skips, chat doesn't need it), so the fan-out is a no-op;
   * it remains wired so that a future reactive plugin can subscribe
   * without DO-level changes. Errors inside individual plugins are
   * swallowed by the runtime — see `ServerPluginRuntime.handleRelay`.
   *
   * Why fire-and-forget rather than await: chat publishes are on the hot
   * path of `handleTool`. Wrapping in `ctx.waitUntil` lets the response
   * return immediately and lets any plugin-side publish settle in the
   * background. The published envelope reaches spectators on the NEXT
   * broadcast cycle (which fires on every chat envelope already, so
   * latency is bounded by chat cadence).
   */
  private fanRelayToPlugins(env: RelayEnvelope): void {
    this.ctx.waitUntil(
      (async () => {
        try {
          const runtime = await this.getPluginRuntime();
          await runtime.handleRelay(env);
        } catch (err) {
          console.error('[GameRoomDO] fanRelayToPlugins failed:', err);
        }
      })(),
    );
  }

  /**
   * Lazy chain-relay accessor. Imports `createRelay` lazily so DO startup
   * doesn't pay viem's module cost when the game never settles (e.g. dev
   * mode without RPC_URL). Cached on first access.
   */
  private _chainRelayPromise: Promise<import('../chain/types.js').ChainRelay> | null = null;
  private lazyCreateRelay(): import('../chain/types.js').ChainRelay {
    // Returns a thin proxy that resolves on first method call. Awaits the
    // dynamic import internally so the SettlementStateMachine sees a real
    // OnChainRelay-shaped object.
    const env = this.env;
    const getRelay = (): Promise<import('../chain/types.js').ChainRelay> => {
      if (!this._chainRelayPromise) {
        this._chainRelayPromise = import('../chain/index.js').then((m) => m.createRelay(env));
      }
      return this._chainRelayPromise;
    };
    return {
      async submit(payload, opts) {
        return (await getRelay()).submit(payload, opts);
      },
      async pollReceipt(txHash) {
        return (await getRelay()).pollReceipt(txHash);
      },
      // The state machine only ever calls submit + pollReceipt; the rest of
      // ChainRelay is irrelevant to its own surface but the type wants
      // them, so forward through the promise as well.
      async getAgentByAddress(addr) {
        return (await getRelay()).getAgentByAddress(addr);
      },
      async checkName(name) {
        return (await getRelay()).checkName(name);
      },
      async register(p) {
        return (await getRelay()).register(p);
      },
      async getBalance(id) {
        return (await getRelay()).getBalance(id);
      },
      async topup(id, p) {
        return (await getRelay()).topup(id, p);
      },
      async requestBurn(id, amt) {
        return (await getRelay()).requestBurn(id, amt);
      },
      async executeBurn(id) {
        return (await getRelay()).executeBurn(id);
      },
      async cancelBurn(id) {
        return (await getRelay()).cancelBurn(id);
      },
    };
  }

  /**
   * Schedule a multiplexed alarm entry. Persists the entry in the queue,
   * then arms the DO alarm slot at the new earliest `when`.
   */
  private async scheduleAlarmEntry(entry: AlarmEntry): Promise<void> {
    const mux = this.getAlarmMux();
    await mux.schedule(entry);
    const earliest = await mux.earliestWhen();
    if (earliest !== null) {
      await this.ctx.storage.setAlarm(earliest);
    }
  }

  /**
   * Cancel every queued entry of `kind` and re-arm the DO alarm slot to
   * the next earliest entry (or clear the slot if the queue is empty).
   */
  private async cancelAlarmKind(kind: string): Promise<void> {
    const mux = this.getAlarmMux();
    await mux.cancelKind(kind);
    const earliest = await mux.earliestWhen();
    if (earliest === null) {
      try {
        await this.ctx.storage.deleteAlarm();
      } catch {}
    } else {
      await this.ctx.storage.setAlarm(earliest);
    }
  }

  /**
   * Lazy accessor for the canonical relay client. Team membership comes from
   * the game plugin's `getTeamForPlayer(state, playerId)` so FFA games (where
   * each player is their own team) and team games share one code path. The
   * cached `_meta.teamMap` is the authoritative fallback when state isn't
   * loaded yet — values come from `createConfig`'s `players[].team`.
   */
  private getRelayClient(): DOStorageRelayClient {
    if (!this._relayClient) {
      this._relayClient = new DOStorageRelayClient(this.ctx.storage, {
        getTeamForPlayer: (playerId) => {
          if (this._plugin && this._state !== null) {
            return this._plugin.getTeamForPlayer(this._state, playerId);
          }
          return this._meta?.teamMap[playerId] ?? null;
        },
        getHandleForPlayer: (playerId) => {
          return this._meta?.handleMap[playerId] ?? null;
        },
      });
    }
    return this._relayClient;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // fetch() — HTTP + WS entry point
  // ─────────────────────────────────────────────────────────────────────────

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;
    const path = url.pathname.replace(/\/$/, '') || '/';

    if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      return this.handleWebSocket(request);
    }

    if (method === 'POST' && path === '/') return this.handleCreate(request);
    if (method === 'POST' && path === '/action') return this.handleAction(request);
    if (method === 'POST' && path === '/tool') return this.handleTool(request);
    if (method === 'GET' && path === '/state') return this.handleState(request);
    if (method === 'GET' && path === '/result') return this.handleResult();
    if (method === 'GET' && path === '/spectator') return this.handleSpectator(request);
    if (method === 'GET' && path === '/replay') return this.handleReplay();
    if (method === 'GET' && path === '/bundle') return this.handleBundle();
    if (method === 'GET' && path === '/inspect') return this.handleInspect();
    if (method === 'DELETE' && path === '/') return this.handleForceFinish();

    return new Response('Not found', { status: 404 });
  }

  /**
   * Admin-only live-state dump. Returns a JSON snapshot of every DO storage
   * key a human might need to diagnose a stuck game (meta, progress, alarm
   * queue, current alarm slot, raw game state, action-log size). Gated by
   * the main Worker's `ADMIN_TOKEN`; this method is unauthenticated on its
   * own because the DO is not directly reachable from the internet.
   */
  private async handleInspect(): Promise<Response> {
    await this.ensureLoaded();
    const mux = this.getAlarmMux();
    const [alarmQueue, alarmSlot, snapshotCount] = await Promise.all([
      this.ctx.storage.get<AlarmEntry[]>(StorageAlarmMux.KEY).then((q) => q ?? []),
      this.ctx.storage.getAlarm(),
      this.ctx.storage.get<number>('snapshotCount'),
    ]);
    const earliest = await mux.earliestWhen();
    const now = Date.now();
    const wsCount = this.ctx.getWebSockets().length;

    const payload = {
      now,
      meta: this._meta,
      progress: this._progress,
      actionLogLength: this._actionLog.length,
      snapshotCount: snapshotCount ?? this._spectatorSnapshots.length,
      alarm: {
        slot: alarmSlot,
        slotDelta: alarmSlot === null ? null : alarmSlot - now,
        earliestQueued: earliest,
        queue: alarmQueue.map((e) => ({ ...e, deltaMs: e.when - now })),
      },
      websockets: wsCount,
      gameState: this._state,
      isOver: this._plugin && this._state !== null ? this._plugin.isOver(this._state) : null,
      pluginProgress:
        this._plugin && this._state !== null ? this._plugin.getProgressCounter(this._state) : null,
    };

    // gameState carries bigints (e.g. OB balances); default JSON.stringify
    // throws on BigInt. Stringify them as `<n>n` so the wire format survives
    // and a human reader can still distinguish number-vs-bigint.
    const body = JSON.stringify(payload, (_k, v) =>
      typeof v === 'bigint' ? `${v.toString()}n` : v,
    );
    return new Response(body, { headers: { 'Content-Type': 'application/json' } });
  }

  /**
   * Admin-only force-finish. Marks the game terminated and clears the
   * alarm so ghost games whose parent lobby row vanished stop ticking the
   * progress counter. The main Worker gates this path behind `ADMIN_TOKEN`.
   */
  private async handleForceFinish(): Promise<Response> {
    await this.ensureLoaded();
    if (!this._meta) return Response.json({ error: 'Game not found' }, { status: 404 });
    this._meta.finished = true;
    this._stateVersion += 1;
    try {
      await this.ctx.storage.deleteAlarm();
    } catch {}
    await Promise.all([
      this.ctx.storage.put('meta', this._meta),
      this.ctx.storage.put('stateVersion', this._stateVersion),
    ]);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(1000, 'Game force-finished by admin');
      } catch {}
    }
    console.log(`[GameRoomDO] force-finished game ${this._meta.gameId}`);
    return Response.json({ ok: true, gameId: this._meta.gameId });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // alarm() — multiplexed dispatcher
  // ─────────────────────────────────────────────────────────────────────────
  //
  // The DO has a single alarm slot. `StorageAlarmMux` queues entries by
  // `{ when, kind, payload }`. On fire we pop everything due, dispatch by
  // `kind`, then re-arm the slot to whatever is earliest in the queue.

  override async alarm(): Promise<void> {
    await this.ensureLoaded();
    const mux = this.getAlarmMux();
    const due = await mux.popDue(Date.now());

    if (due.length === 0) {
      // Spurious wakeup — nothing was due. Re-arm to the next entry if
      // any (handles clock drift / DO scheduler weirdness).
      const next = await mux.earliestWhen();
      if (next !== null) {
        await this.ctx.storage.setAlarm(next);
      }
      return;
    }

    for (const entry of due) {
      try {
        await this.dispatchAlarm(entry);
      } catch (err) {
        console.error(`[GameRoomDO] alarm dispatch failed kind=${entry.kind}:`, err);
        // Don't rethrow — other queued kinds in `due` should still get a
        // shot at running.
      }
    }

    // Re-arm to the earliest remaining entry. Empty queue → leave the
    // slot unset (CF won't fire again until the next schedule call).
    const next = await mux.earliestWhen();
    if (next !== null) {
      await this.ctx.storage.setAlarm(next);
    }
  }

  /**
   * Dispatch a single popped alarm entry to its handler. Each `kind`
   * needs exactly one of these.
   */
  private async dispatchAlarm(entry: AlarmEntry): Promise<void> {
    if (entry.kind === 'deadline') {
      await this.dispatchDeadlineAlarm(entry);
      return;
    }
    if (entry.kind === SETTLEMENT_ALARM_KIND) {
      const runtime = await this.getPluginRuntime();
      await runtime.handleAlarm(SETTLEMENT_ALARM_KIND);
      return;
    }
    console.warn(`[GameRoomDO] unknown alarm kind: ${entry.kind}`);
  }

  /**
   * Turn-deadline alarm handler. Mirrors the pre-3.2 behavior except the
   * deadline data is on the queued payload rather than a 'deadline' key.
   */
  private async dispatchDeadlineAlarm(entry: AlarmEntry): Promise<void> {
    if (!this._meta || !this._plugin) return;
    const payload = entry.payload as DeadlineEntry | null;
    if (!payload) return;

    if (Date.now() < payload.deadlineMs - 500) {
      // Clock drift — re-queue this same entry. (Schedule pushes it back
      // onto the queue; the post-loop re-arm picks the right `when`.)
      await this.getAlarmMux().schedule({
        when: payload.deadlineMs,
        kind: 'deadline',
        payload,
      });
      return;
    }

    console.log(
      `[GameRoomDO] Deadline alarm fired — applying action for turn ${this._progress.counter}`,
    );
    try {
      await this.applyActionInternal(null, payload.action);
    } catch (err) {
      console.error(`[GameRoomDO] Deadline action failed:`, err instanceof Error ? err.stack : err);
      // The popDue() already removed this entry, so we won't infinite-loop;
      // just rethrow for observability.
      throw err;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // WebSocket lifecycle (hibernatable)
  // ─────────────────────────────────────────────────────────────────────────

  async webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer): Promise<void> {
    // All WS connections are receive-only (spectators and players).
    // Players submit actions via POST /action, not via WS.
  }

  async webSocketClose(_ws: WebSocket): Promise<void> {
    // CF removes closed sockets from getWebSockets() automatically.
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Route handlers
  // ─────────────────────────────────────────────────────────────────────────

  private async handleCreate(request: Request): Promise<Response> {
    if (this._meta) return Response.json({ error: 'Game already created' }, { status: 409 });

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const {
      gameType: rawGameType,
      config,
      playerIds,
      handleMap,
      teamMap,
      gameId: bodyGameId,
    } = body ?? ({} as Record<string, unknown>);
    if (!rawGameType || !config || !Array.isArray(playerIds)) {
      return Response.json(
        { error: 'gameType, config, and playerIds are required' },
        { status: 400 },
      );
    }
    const gameType = rawGameType as string;

    const plugin = getGame(gameType);
    if (!plugin) return Response.json({ error: `Unknown game type: ${gameType}` }, { status: 400 });

    let initialState: unknown;
    try {
      initialState = plugin.createInitialState(config);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return Response.json({ error: `createInitialState failed: ${msg}` }, { status: 400 });
    }

    // Authoritative: ctx.id.name IS the gameId. Body field is optional and
    // must match if present — otherwise an attacker could pre-claim a future
    // game UUID and brick its on-chain settlement. See resolve-gameid.ts.
    // @ts-expect-error TS2345: Argument of type 'string | undefined' is not assignable to parameter of type 'st — TODO(2.3-followup)
    const resolved = resolveGameId(bodyGameId as string | undefined, this.ctx.id.name);
    if (resolved.ok === false) {
      console.warn(
        `[GameRoomDO] settlement.gameid.mismatch requestedId=${resolved.log.requestedId} actualId=${resolved.log.actualId}`,
      );
      return new Response(resolved.body, { status: resolved.status });
    }
    const gameId = resolved.gameId;
    const meta: GameMeta = {
      gameId,
      gameType,
      playerIds: playerIds as string[],
      handleMap: (handleMap as Record<string, string>) ?? {},
      teamMap: (teamMap as Record<string, string>) ?? {},
      createdAt: new Date().toISOString(),
      finished: false,
      spectatorDelay: plugin.spectatorDelay ?? 0,
    };
    const progress: ProgressState = { counter: 0 };

    // Build initial spectator snapshot (turn 0)
    const initialCtx = { handles: meta.handleMap, relayMessages: [] };
    const initialSnapshot = plugin.buildSpectatorView(initialState, null, initialCtx);

    this._stateVersion = 1;
    await Promise.all([
      this.ctx.storage.put('meta', meta),
      this.ctx.storage.put('state', initialState),
      this.ctx.storage.put('actionLog', []),
      this.ctx.storage.put('progress', progress),
      this.ctx.storage.put('config', config),
      this.ctx.storage.put('snapshotCount', 1),
      this.ctx.storage.put('snapshot:0', initialSnapshot),
      this.ctx.storage.put('stateVersion', this._stateVersion),
    ]);

    this._meta = meta;
    this._plugin = plugin;
    this._state = initialState;
    this._actionLog = [];
    this._progress = progress;
    // @ts-expect-error TS2339: Property '_config' does not exist on type 'GameRoomDO'. — TODO(2.3-followup)
    this._config = config;
    this._spectatorSnapshots = [initialSnapshot];
    this._loaded = true;

    // Write initial summary to D1 so /api/games shows real data from turn 0
    this.writeSummaryToD1();

    console.log(`[GameRoomDO] Created ${gameType} game, ${playerIds.length} players`);
    return Response.json({ ok: true, gameType, playerCount: playerIds.length });
  }

  private async handleAction(request: Request): Promise<Response> {
    await this.ensureLoaded();
    if (!this._meta) return Response.json({ error: 'Game not found' }, { status: 404 });
    if (this._meta.finished)
      return Response.json({ error: 'Game already finished' }, { status: 410 });

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const { action } = body ?? ({} as Record<string, unknown>);
    if (action === undefined)
      return Response.json({ error: 'action is required' }, { status: 400 });

    const playerId = this.trustedPlayerId(request);
    if (playerId instanceof Response) return playerId;

    try {
      const applied = await this.applyActionInternal(playerId, action);
      if (!applied.success || playerId === null) {
        // Validation rejection (or system action with no viewer) — preserve
        // the small shape the dispatcher already knows how to translate.
        return Response.json(applied);
      }
      // Success — return the post-action state envelope for the caller.
      // Cursors ride along on the URL so the DO can ETag + relay-delta the
      // response the same way /state does.
      const url = new URL(request.url);
      const rawSince = url.searchParams.get('sinceIdx');
      const sinceIdx = rawSince === null ? undefined : Number(rawSince);
      const rawVersion = url.searchParams.get('knownStateVersion');
      const knownStateVersion = rawVersion === null ? undefined : Number(rawVersion);
      const envelope = await this.buildPlayerPayload(playerId, sinceIdx, knownStateVersion);
      return Response.json({ ok: true, ...applied, ...envelope });
    } catch (err) {
      const stack = err instanceof Error ? err.stack : undefined;
      console.error(`[GameRoomDO] Error in applyActionInternal:`, stack ?? err);
      return Response.json(
        { error: 'Internal server error', details: String(err), stack: stack ?? '' },
        { status: 500 },
      );
    }
  }

  private async handleState(request: Request): Promise<Response> {
    await this.ensureLoaded();
    if (!this._meta || !this._plugin)
      return Response.json({ error: 'Game not found' }, { status: 404 });

    const playerId = this.trustedPlayerId(request);
    if (playerId instanceof Response) return playerId;

    // Unified envelope for both. Player callers get a fog-filtered current
    // state + top-level `currentPhase`/`gameOver`; spectator callers get
    // the delayed public snapshot. `?sinceIdx=N` is honored on both paths
    // so CLI callers can request relay deltas. `?knownStateVersion=N` is
    // the ETag cursor — when it matches the DO's current version the server
    // omits the state block and the client reuses its cache.
    const url = new URL(request.url);
    const rawSince = url.searchParams.get('sinceIdx');
    const sinceIdx = rawSince === null ? undefined : Number(rawSince);
    const rawVersion = url.searchParams.get('knownStateVersion');
    const knownStateVersion = rawVersion === null ? undefined : Number(rawVersion);
    if (playerId !== null) {
      return Response.json(await this.buildPlayerPayload(playerId, sinceIdx, knownStateVersion));
    }
    return Response.json(
      await this.buildSpectatorPayload({ kind: 'spectator' }, sinceIdx, knownStateVersion),
    );
  }

  /**
   * Single trust boundary for player identity. Read X-Player-Id from
   * the request headers (set by the authenticated Worker, or absent
   * for internal system calls). Never trust request bodies or query
   * params. Returns a Response on auth failure; null means "system
   * action — no authenticated player".
   */
  private trustedPlayerId(request: Request): string | null | Response {
    const header = request.headers.get('X-Player-Id');
    const playerId = header && header.length > 0 ? header : null;
    if (playerId !== null && this._meta && !this._meta.playerIds.includes(playerId)) {
      return Response.json({ error: 'Not a player in this game' }, { status: 403 });
    }
    return playerId;
  }

  private async handleResult(): Promise<Response> {
    await this.ensureLoaded();
    if (!this._meta || !this._plugin)
      return Response.json({ error: 'Game not found' }, { status: 404 });
    if (!this._plugin.isOver(this._state)) {
      return Response.json({ error: 'Game not finished yet' }, { status: 409 });
    }

    const leaves: MerkleLeafData[] = this._actionLog.map((e, i) => ({
      actionIndex: i,
      playerId: e.playerId,
      actionData: JSON.stringify(e.action),
    }));
    const tree = buildActionMerkleTree(leaves);

    const config = {
      gameType: this._meta.gameType,
      playerIds: this._meta.playerIds,
      handleMap: this._meta.handleMap,
      teamMap: this._meta.teamMap,
      createdAt: this._meta.createdAt,
    };
    const configJson = JSON.stringify(config, Object.keys(config).sort());
    const encoder = new TextEncoder();
    const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(configJson));
    const configHash =
      '0x' +
      Array.from(new Uint8Array(hashBuffer))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');

    return Response.json({
      gameType: this._meta.gameType,
      playerIds: this._meta.playerIds,
      outcome: this._plugin.getOutcome(this._state),
      movesRoot: tree.root,
      turnCount: this._actionLog.length,
      timestamp: Date.now(),
      configHash,
    });
  }

  private async handleBundle(): Promise<Response> {
    await this.ensureLoaded();
    if (!this._meta || !this._plugin)
      return Response.json({ error: 'Game not found' }, { status: 404 });
    if (!this._plugin.isOver(this._state)) {
      return Response.json({ error: 'Game not finished yet' }, { status: 409 });
    }

    const config = {
      gameType: this._meta.gameType,
      playerIds: this._meta.playerIds,
      handleMap: this._meta.handleMap,
      teamMap: this._meta.teamMap,
      createdAt: this._meta.createdAt,
    };

    const turns = this._actionLog.map((entry, i) => ({
      turnNumber: i,
      moves: [
        {
          // @ts-expect-error TS2538: Type 'null' cannot be used as an index type. — TODO(2.3-followup)
          player: this._meta?.handleMap[entry.playerId] || entry.playerId,
          data: JSON.stringify(entry.action),
          signature: '',
        },
      ],
      result: null,
    }));

    return Response.json({ config, turns });
  }

  private async handleSpectator(request: Request): Promise<Response> {
    await this.ensureLoaded();
    if (!this._meta || !this._plugin)
      return Response.json({ error: 'Game not found' }, { status: 404 });
    const url = new URL(request.url);
    const rawSince = url.searchParams.get('sinceIdx');
    const sinceIdx = rawSince === null ? undefined : Number(rawSince);
    const rawVersion = url.searchParams.get('knownStateVersion');
    const knownStateVersion = rawVersion === null ? undefined : Number(rawVersion);
    return Response.json(
      await this.buildSpectatorPayload({ kind: 'spectator' }, sinceIdx, knownStateVersion),
    );
  }

  private async handleReplay(): Promise<Response> {
    await this.ensureLoaded();
    if (!this._meta || !this._plugin)
      return Response.json({ error: 'Game not found' }, { status: 404 });

    const idx = this.publicSnapshotIndex();
    if (idx === null) {
      // Pre-window: delay hasn't elapsed yet. Nothing public to show.
      return Response.json({
        type: 'spectator_pending',
        gameType: this._meta.gameType,
        gameId: this._meta.gameId,
        handles: this._meta.handleMap,
        teamMap: this._meta.teamMap,
        finished: false,
        progressCounter: null,
        snapshots: [],
      });
    }

    // Raw _relay is NOT returned: it contains DMs, team chat, and per-turn
    // cadence. Chat a spectator is entitled to read is already baked into
    // the snapshots themselves.
    return Response.json({
      type: 'replay',
      gameType: this._meta.gameType,
      gameId: this._meta.gameId,
      handles: this._meta.handleMap,
      teamMap: this._meta.teamMap,
      finished: this._meta.finished,
      progressCounter: idx,
      snapshots: this._spectatorSnapshots.slice(0, idx + 1),
    });
  }

  private async handleWebSocket(request: Request): Promise<Response> {
    await this.ensureLoaded();

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

    // X-Player-Id is set by the Worker after validating the Bearer token.
    // Absent = spectator (no auth required).
    const playerId = request.headers.get('X-Player-Id');
    // `?sinceIdx=N` filters the initial snapshot to relay envelopes >= N
    // so a CLI reconnect doesn't replay history it already has.
    // `?knownStateVersion=N` is the ETag cursor — when it matches the
    // current version the initial frame omits the state block (the client
    // is reconnecting with a fresh cache and only needs wake-up pulses).
    const url = new URL(request.url);
    const rawSince = url.searchParams.get('sinceIdx');
    const sinceIdx = rawSince === null ? undefined : Number(rawSince);
    const rawVersion = url.searchParams.get('knownStateVersion');
    const knownStateVersion = rawVersion === null ? undefined : Number(rawVersion);

    if (playerId) {
      // Authenticated player connection
      this.ctx.acceptWebSocket(server, [playerId]);
      if (this._meta && this._plugin) {
        server.send(
          JSON.stringify(await this.buildPlayerPayload(playerId, sinceIdx, knownStateVersion)),
        );
      }
    } else {
      // Unauthenticated spectator connection — same unified payload that
      // HTTP /state and /spectator return. WS sends the initial snapshot
      // (filtered by sinceIdx if supplied), then deltas on each broadcast.
      this.ctx.acceptWebSocket(server, [TAG_SPECTATOR]);
      if (this._meta && this._plugin) {
        server.send(
          JSON.stringify(
            await this.buildSpectatorPayload({ kind: 'spectator' }, sinceIdx, knownStateVersion),
          ),
        );
      }
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Plugin tool call handler
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * POST /tool — accepts a pre-formed relay envelope.
   * Body: { relay: { type, data, scope, pluginId } }.
   * Sender identity comes from X-Player-Id (never the body).
   */
  private async handleTool(request: Request): Promise<Response> {
    await this.ensureLoaded();
    if (!this._meta) return Response.json({ error: 'Game not found' }, { status: 404 });

    const playerId = this.trustedPlayerId(request);
    if (playerId instanceof Response) return playerId;
    if (playerId === null) {
      return Response.json(
        { error: 'X-Player-Id header required for tool calls' },
        { status: 401 },
      );
    }

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const { relay } = body ?? ({} as Record<string, unknown>);
    if (!relay) {
      return Response.json({ error: 'relay envelope is required' }, { status: 400 });
    }
    const relayObj = relay as Record<string, unknown>;
    if (!relayObj.type || !relayObj.pluginId) {
      return Response.json({ error: 'relay must have type and pluginId' }, { status: 400 });
    }

    if (relayObj.type === CHAT_RELAY_TYPE) {
      const scopeError = validateChatScope(
        relayObj.scope as string | undefined,
        this._plugin?.chatScopes,
      );
      if (scopeError) {
        return Response.json(
          { error: { code: 'INVALID_CHAT_SCOPE', message: scopeError } },
          { status: 400 },
        );
      }
    }

    try {
      const scope = resolveWireScope(
        relayObj.scope as string | undefined,
        playerId,
        this._meta.teamMap,
      );
      const partial = {
        type: relayObj.type as string,
        data: relayObj.data ?? null,
        scope,
        pluginId: relayObj.pluginId as string,
        sender: playerId,
        turn: this._progress.counter,
      };
      await this.getRelayClient().publish(partial);
      // After publish the envelope's index is the relay tip - 1; we re-read
      // it from a tiny visibleTo({admin}) below only when we need the full
      // envelope to push. For the broadcast we just rebuild player messages.
      await this.broadcastRelayMessage(scope);
      // Phase 5.4 — fan envelopes through the per-DO plugin runtime so
      // any future reactive plugin can subscribe. Index/timestamp aren't
      // strictly accurate here (the RelayClient assigned them internally),
      // but no current handleRelay consumer cares — they all key off
      // `type`, `turn`, `data`, `scope`. Synthesizing avoids a round-trip
      // read.
      const tip = await this.getRelayClient().getTip();
      const synthesized: RelayEnvelope = {
        ...partial,
        index: Math.max(0, tip - 1),
        timestamp: Date.now(),
      };
      this.fanRelayToPlugins(synthesized);

      // Return the post-publish state envelope. Cursors on the URL drive
      // the ETag + relay delta — typical chat-only path emits `state: null`
      // and a one-envelope relay, so responses stay tiny.
      const url = new URL(request.url);
      const rawSince = url.searchParams.get('sinceIdx');
      const sinceIdx = rawSince === null ? undefined : Number(rawSince);
      const rawVersion = url.searchParams.get('knownStateVersion');
      const knownStateVersion = rawVersion === null ? undefined : Number(rawVersion);
      const envelope = await this.buildPlayerPayload(playerId, sinceIdx, knownStateVersion);
      return Response.json({ ok: true, ...envelope });
    } catch (err) {
      console.error(`[GameRoomDO] Error in handleTool:`, err);
      return Response.json(
        { error: 'Internal server error', details: String(err) },
        { status: 500 },
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Relay helpers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Push a freshly-published relay envelope to the players who should
   * receive it. We compute the recipient set from the envelope's scope
   * (avoids shipping a full per-player rebuild to every WS connection in
   * the game when only a DM/team subset is interested), then build and
   * send a fresh player message for each recipient — the message
   * embeds the player's full visible relay slice via `visibleTo`.
   */
  private async broadcastRelayMessage(scope: RelayScope): Promise<void> {
    if (!this._meta) return;
    const recipients = this.resolveRelayRecipients(scope);
    for (const pid of recipients) {
      const conns = this.ctx.getWebSockets(pid);
      if (conns.length === 0) continue;
      const payload = JSON.stringify(await this.buildPlayerPayload(pid));
      for (const ws of conns) {
        try {
          ws.send(payload);
        } catch {}
      }
    }
    // Phase 7.1 — when chat is publicly visible (`'all'` scope) also bump
    // every spectator WS so the unified payload gains the new envelope.
    // Team/DM chat stays hidden from spectators per `isVisible`.
    if (scope.kind === 'all') {
      await this.broadcastSpectatorPayload();
    }
  }

  /**
   * Resolve recipient playerIds for a scope. `'all'` → every player.
   * `'team'` → all players whose teamMap entry matches. `'dm'` → the
   * recipient (matched by playerId OR display handle).
   *
   * Note: for DMs we deliberately do NOT include the sender here. The
   * sender's own connection sees their just-published DM via the next
   * /tool POST response or the next state read; pushing a duplicate
   * here would only matter for the sender's own DM on a different tab
   * (a WS push) — and that case is rare enough that we accept the
   * trade-off in exchange for a simpler scope→pids mapping.
   */
  private resolveRelayRecipients(scope: RelayScope): string[] {
    if (!this._meta) return [];
    const { playerIds, teamMap, handleMap } = this._meta;
    if (scope.kind === 'all') return playerIds;
    if (scope.kind === 'team') {
      return playerIds.filter((pid) => teamMap[pid] === scope.teamId);
    }
    // DM: find recipient by playerId or display handle.
    const target = scope.recipientHandle;
    const recipient = playerIds.find((pid) => pid === target || (handleMap[pid] ?? pid) === target);
    return recipient ? [recipient] : [];
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Core game logic
  // ─────────────────────────────────────────────────────────────────────────

  private async applyActionInternal(
    playerId: string | null,
    action: unknown,
  ): Promise<{ success: boolean; error?: string; progressCounter?: number }> {
    if (!this._plugin || !this._meta) return { success: false, error: 'Game not loaded' };

    if (!this._plugin.validateAction(this._state, playerId, action)) {
      return { success: false, error: 'Invalid action' };
    }

    const prevState = this._state;
    // Read the prev-state progress counter BEFORE applyAction; the new state
    // is what we compare against to know whether to snapshot.
    const prevProgress = this._plugin.getProgressCounter(prevState);
    const result = this._plugin.applyAction(prevState, playerId, action);
    this._state = result.state;
    this._actionLog.push({ playerId, action });

    // Deadline management — discriminated union per Phase 4.6.
    //   omitted        -> leave alarm unchanged
    //   { kind:'none' } -> cancel
    //   { kind:'absolute', at } -> set absolute alarm
    //
    // Phase 3.2: deadlines route through the alarm multiplexer so settlement
    // and turn deadlines coexist on the single DO alarm slot.
    if (result.deadline !== undefined) {
      if (result.deadline.kind === 'none') {
        // @ts-expect-error TS2339: Property '_deadlineMs' does not exist on type 'GameRoomDO'. — TODO(2.3-followup)
        this._deadlineMs = null;
        await this.cancelAlarmKind('deadline');
      } else {
        const deadlineMs = result.deadline.at;
        // @ts-expect-error TS2339: Property '_deadlineMs' does not exist on type 'GameRoomDO'. — TODO(2.3-followup)
        this._deadlineMs = deadlineMs;
        // Replace any existing deadline entry with the new one (a deadline is
        // a single per-game timer, not a queue).
        await this.cancelAlarmKind('deadline');
        await this.scheduleAlarmEntry({
          when: deadlineMs,
          kind: 'deadline',
          payload: { action: result.deadline.action, deadlineMs },
        });
      }
    }

    // Progress tick: derived from the game's own counter rather than a
    // boolean flag on ActionResult (Phase 4.6). Snapshot whenever the
    // counter advances (defensive >= guard so any rewind would be a no-op).
    const newProgress = this._plugin.getProgressCounter(this._state);
    const progressAdvanced = newProgress > prevProgress;

    if (progressAdvanced) {
      this._progress.counter++;

      // Capture spectator snapshot at this progress point.
      // Include all 'all' + 'team' relay messages up to this turn for chat
      // replay (DMs are excluded by definition — they're 1:1). We pull the
      // full envelope set through the admin viewer (no filtering at the
      // client) and filter scope here so the snapshot semantics match the
      // pre-Phase-4.4 behavior exactly.
      const allEnvelopes = await this.getRelayClient().visibleTo({ kind: 'admin' });
      const snapshotRelay = allEnvelopes.filter(
        (m) => m.scope.kind === 'all' || m.scope.kind === 'team',
      );
      const snapshotCtx = { handles: this._meta.handleMap, relayMessages: snapshotRelay };
      const snapshot = this._plugin.buildSpectatorView(this._state, prevState, snapshotCtx);
      this._spectatorSnapshots.push(snapshot);

      // Update cached summary in D1
      this.writeSummaryToD1();
    }

    this._stateVersion += 1;
    const storagePuts: Promise<void>[] = [
      this.ctx.storage.put('state', this._state),
      this.ctx.storage.put('actionLog', this._actionLog),
      this.ctx.storage.put('progress', this._progress),
      this.ctx.storage.put('stateVersion', this._stateVersion),
    ];
    if (progressAdvanced) {
      const idx = this._spectatorSnapshots.length - 1;
      storagePuts.push(
        this.ctx.storage.put(`snapshot:${idx}`, this._spectatorSnapshots[idx]),
        this.ctx.storage.put('snapshotCount', this._spectatorSnapshots.length),
      );
    }
    await Promise.all(storagePuts);

    const finished = this._plugin.isOver(this._state);
    if (finished && !this._meta.finished) {
      this._meta.finished = true;
      await this.ctx.storage.put('meta', this._meta);
      // Game's over — drop the turn-deadline entry (settlement may schedule
      // its own alarm next, so we don't blanket-clear the slot).
      await this.cancelAlarmKind('deadline');
      console.log(
        `[GameRoomDO] Game over — ${this._meta.gameType}, ${this._actionLog.length} actions`,
      );
      // Write final summary (with finished=true reflected in game state)
      this.writeSummaryToD1();
      // Mark the game finished in D1. Player sessions still point at the
      // parent lobby (via player_sessions → lobbies.game_id), so state reads
      // continue to resolve here and return gameOver: true until the player
      // joins a new lobby (which UPDATEs their session pointer).
      try {
        await this.env.DB.prepare('UPDATE games SET finished = 1 WHERE game_id = ?')
          .bind(this._meta.gameId)
          .run();
      } catch (err) {
        console.error(`[GameRoomDO] Failed to update D1 on game over:`, err);
      }
      // Phase 3.2: settle on-chain via SettlementStateMachine. The state
      // machine takes ownership of retries + receipt polling — once
      // submit() returns, the alarm path drives it to terminal. Wrap the
      // first submit in waitUntil so the request response doesn't trigger
      // hibernation mid-broadcast.
      this.ctx.waitUntil(this.kickOffSettlement());
    }

    await this.broadcastUpdates();

    return { success: true, progressCounter: this._progress.counter };
  }

  /**
   * Anchor the finished game on-chain with credit deltas from the plugin.
   *
   * Phase 3.2: this method now builds the payload + enforces invariants, then
   * hands off to `SettlementStateMachine`. The state machine survives Worker
   * hibernation, retries with a pinned nonce on RPC failure, and treats the
   * contract's `AlreadySettled` revert as idempotent confirmation.
   *
   * Server-side invariants (enforced before kicking off the state machine):
   *   • sum(deltas) === 0              — zero-sum; GameAnchor enforces this too
   *   • every delta ≥ -entryCost       — no player loses more than their stake
   *   • every player has chain_agent_id — only registered identities can settle
   *
   * If any invariant fails we log and skip — never throw, never attack chain.
   * MockRelay ignores deltas, so in dev mode this still exercises the path.
   */
  private async kickOffSettlement(): Promise<void> {
    if (!this._plugin || !this._meta) return;
    const gameId = this._meta.gameId;
    const { playerIds, gameType, handleMap, teamMap, createdAt } = this._meta;

    try {
      // Build merkle + configHash
      const leaves: MerkleLeafData[] = this._actionLog.map((e, i) => ({
        actionIndex: i,
        playerId: e.playerId,
        actionData: JSON.stringify(e.action),
      }));
      const tree = buildActionMerkleTree(leaves);

      const config = { gameType, playerIds, handleMap, teamMap, createdAt };
      const configJson = JSON.stringify(config, Object.keys(config).sort());
      const hashBuffer = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(configJson),
      );
      const configHash = ('0x' +
        Array.from(new Uint8Array(hashBuffer))
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('')) as `0x${string}`;

      const outcome = this._plugin.getOutcome(this._state);
      // `plugin.entryCost` is already a `bigint` in raw credit units (6-dec,
      // matching `CoordinationCredits` storage). Plugin authors declare it
      // via `credits(n)` so the type system prevents unit confusion —
      // `computePayouts`, the invariant checks below, and the int256 deltas
      // relayed to the contract all live in raw-unit space.
      const entryCost = this._plugin.entryCost;
      const payouts = this._plugin.computePayouts(outcome, playerIds, entryCost);

      // Build delta array in playerIds order; default to 0n for any missing entry
      const deltas: { agentId: string; delta: bigint }[] = playerIds.map((id) => ({
        agentId: id,
        delta: payouts.get(id) ?? 0n,
      }));

      const renderDeltas = () =>
        deltas.map((d) => ({ agentId: d.agentId, delta: d.delta.toString() }));

      // Invariant 1: zero-sum (BigInt-exact — no float rounding to mask bugs).
      const sum = deltas.reduce((acc, d) => acc + d.delta, 0n);
      if (sum !== 0n) {
        console.error(
          `[settle ${gameId}] skip: non-zero-sum deltas sum=${sum.toString()}`,
          renderDeltas(),
        );
        return;
      }

      // Invariant 2: no player loses more than their stake.
      const floorViolation = deltas.find((d) => d.delta < -entryCost);
      if (floorViolation) {
        console.error(
          `[settle ${gameId}] skip: delta ${floorViolation.delta.toString()} < -entryCost(${entryCost.toString()}) for ${floorViolation.agentId}`,
          renderDeltas(),
        );
        return;
      }

      // Invariant 3: all players must have an on-chain identity (in on-chain mode).
      // MockRelay doesn't use chain_agent_id — skip this check when RPC_URL is unset.
      if (this.env.RPC_URL) {
        const rows = await this.env.DB.prepare(
          `SELECT id, chain_agent_id FROM players WHERE id IN (${playerIds.map(() => '?').join(',')})`,
        )
          .bind(...playerIds)
          .all<{ id: string; chain_agent_id: number | null }>();
        const chainMap = new Map((rows.results ?? []).map((r) => [r.id, r.chain_agent_id]));
        const unregistered = playerIds.filter((id) => !chainMap.get(id));
        if (unregistered.length > 0) {
          console.warn(
            `[settle ${gameId}] skip: ${unregistered.length}/${playerIds.length} players lack chain_agent_id`,
            unregistered,
          );
          return;
        }
      }

      // merkle.ts returns 0x-prefixed hex (keccak256), already a viem-ready bytes32.
      const movesRoot = tree.root as `0x${string}`;

      const runtime = await this.getPluginRuntime();
      await runtime.handleCall(
        SETTLEMENT_PLUGIN_ID,
        'submit',
        {
          gameId,
          gameType,
          playerIds,
          outcome,
          movesRoot,
          configHash,
          turnCount: this._actionLog.length,
          timestamp: Date.now(),
          deltas,
        },
        // Settlement is server-driven (not a player action). Use the
        // admin viewer kind — the plugin doesn't gate on viewer today,
        // but this future-proofs against a `requireAdmin` predicate.
        { kind: 'admin' },
      );
    } catch (err) {
      console.error(`[settle ${gameId}] kickOff failed:`, err);
    }
  }

  /**
   * Fire-and-forget D1 upsert of the public game summary. Gated by
   * publicSnapshotIndex so /api/games never reveals a turn ahead of
   * what the spectator view has caught up to.
   */
  private writeSummaryToD1(): void {
    if (!this._meta || !this._plugin) return;

    const idx = this.publicSnapshotIndex();
    if (idx === null) return;

    const publicSnapshot = this._spectatorSnapshots[idx];
    let summary: Record<string, unknown> = {};
    if (typeof this._plugin.getSummaryFromSpectator === 'function') {
      summary = this._plugin.getSummaryFromSpectator(publicSnapshot);
    } else if (typeof this._plugin.getSummary === 'function') {
      // Plugins that omit getSummaryFromSpectator must have a spectator
      // shape that getSummary can read directly (same field names).
      summary = this._plugin.getSummary(publicSnapshot);
    }
    const json = JSON.stringify(summary);
    // Fire-and-forget: catch all errors to prevent unhandled rejections
    (async () => {
      try {
        await this.env.DB.prepare(
          `INSERT INTO game_summaries (game_id, progress_counter, summary_json, updated_at)
           VALUES (?1, ?2, ?3, datetime('now'))
           ON CONFLICT(game_id) DO UPDATE SET
             progress_counter = ?2, summary_json = ?3, updated_at = datetime('now')`,
        )
          .bind(this._meta?.gameId, idx, json)
          .run();
      } catch (err) {
        // Auto-create table if it doesn't exist yet (migration not applied)
        if (String(err).includes('no such table')) {
          try {
            await this.env.DB.exec(
              `CREATE TABLE IF NOT EXISTS game_summaries (
                game_id TEXT PRIMARY KEY REFERENCES games(game_id),
                progress_counter INTEGER NOT NULL DEFAULT 0,
                summary_json TEXT NOT NULL DEFAULT '{}',
                updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
            );
            // Retry the upsert
            await this.env.DB.prepare(
              `INSERT INTO game_summaries (game_id, progress_counter, summary_json, updated_at)
               VALUES (?1, ?2, ?3, datetime('now'))
               ON CONFLICT(game_id) DO UPDATE SET
                 progress_counter = ?2, summary_json = ?3, updated_at = datetime('now')`,
            )
              .bind(this._meta?.gameId, idx, json)
              .run();
          } catch (e) {
            console.error(`[GameRoomDO] Failed to auto-create game_summaries:`, e);
          }
        } else {
          console.error(`[GameRoomDO] Failed to write summary:`, err);
        }
      }
    })().catch((err) => {
      // Final catch-all to prevent unhandled rejections
      console.error(`[GameRoomDO] Unhandled error in writeSummaryToD1:`, err);
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Message builders
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Build the unified spectator envelope for an authenticated player.
   * `state` is the fog-filtered current game state (NOT the delayed
   * spectator snapshot). `currentPhase` + `gameOver` are populated at the
   * top level so CLI / bot callers can read the callable tool surface
   * without a second endpoint.
   */
  private async buildPlayerPayload(
    playerId: string,
    sinceIdx?: number,
    knownStateVersion?: number,
  ): Promise<SpectatorPayload> {
    if (!this._meta || !this._plugin) {
      return {
        type: 'spectator_pending',
        meta: {
          gameId: this.ctx.id.name ?? '__unknown__',
          gameType: '__unknown__',
          handles: {},
          progressCounter: null,
          finished: false,
          sinceIdx: 0,
          stateVersion: this._stateVersion,
          lastUpdate: Date.now(),
        },
      };
    }
    const finished = this._plugin.isOver(this._state);
    const visible = this._plugin.getVisibleState(this._state, playerId);
    const viewer: SpectatorViewer = { kind: 'player', playerId };
    const relayClient = this.getRelayClient();
    const relayTip = await relayClient.getTip();
    // Today every game has one game phase. When GamePhase[] lands this
    // becomes the current GamePhase's {id, name, tools}.
    const currentPhase = {
      id: 'game',
      name: 'Game',
      tools: this._plugin.gameTools ?? [],
    };
    return buildSpectatorPayload({
      gameId: this._meta.gameId,
      gameType: this._meta.gameType,
      handles: this._meta.handleMap,
      finished,
      // Player view is the CURRENT state — no spectator-delay clamp.
      // Pass a synthetic non-null index so the builder emits a state_update
      // envelope (null index short-circuits to spectator_pending).
      publicSnapshotIndex: this._progress.counter,
      state: visible,
      viewer,
      relay: relayClient,
      relayTip,
      sinceIdx,
      stateVersion: this._stateVersion,
      knownStateVersion,
      currentPhase,
      gameOver: finished,
    });
  }

  /**
   * Highest snapshot index a caller without player-level authorisation
   * may see. `null` pre-window. Sole gate for every public emission —
   * spectator WS, /spectator, /replay, /api/games summary.
   */
  private publicSnapshotIndex(): number | null {
    if (!this._meta) return null;
    return computePublicSnapshotIndex(
      this._spectatorSnapshots.length,
      this._meta.finished,
      this._meta.spectatorDelay ?? 0,
    );
  }

  /**
   * Phase 7.1 — unified spectator payload (HTTP + WS share this builder).
   *
   * Same shape on both transports. The `viewer` is supplied by the call
   * site (always `{kind:'spectator'}` today; admin/replay viewers route
   * through `handleReplay`). `sinceIdx` is clamped to `[0, relayTip]` —
   * see `clampSinceIdx` in `spectator-payload.ts`.
   */
  private async buildSpectatorPayload(
    viewer: SpectatorViewer,
    sinceIdx?: number,
    knownStateVersion?: number,
  ): Promise<SpectatorPayload> {
    if (!this._meta) {
      // Defensive: caller should have checked meta before invoking us, but
      // surface a synthetic pending payload rather than throw so the WS
      // path doesn't crash if a connection lands during a teardown race.
      return {
        type: 'spectator_pending',
        meta: {
          gameId: this.ctx.id.name ?? '__unknown__',
          gameType: '__unknown__',
          handles: {},
          progressCounter: null,
          finished: false,
          sinceIdx: 0,
          stateVersion: this._stateVersion,
          lastUpdate: Date.now(),
        },
      };
    }
    const idx = this.publicSnapshotIndex();
    const state = idx !== null ? this._spectatorSnapshots[idx] : null;
    const relayClient = this.getRelayClient();
    const relayTip = await relayClient.getTip();
    return buildSpectatorPayload({
      gameId: this._meta.gameId,
      gameType: this._meta.gameType,
      handles: this._meta.handleMap,
      finished: this._meta.finished,
      publicSnapshotIndex: idx,
      state: state ?? null,
      viewer,
      relay: relayClient,
      relayTip,
      sinceIdx,
      stateVersion: this._stateVersion,
      knownStateVersion,
    });
  }

  private async broadcastUpdates(): Promise<void> {
    if (!this._meta || !this._plugin) return;

    try {
      // Push to spectators only on public-index advance — prevents
      // counting push events to infer hidden action cadence.
      const idx = this.publicSnapshotIndex();
      if (idx !== this._lastSpectatorIdx) {
        await this.broadcastSpectatorPayload();
        this._lastSpectatorIdx = idx;
        // Persist so a post-eviction wake-up doesn't re-broadcast the
        // same index spectators already have. Write only on actual
        // bumps — broadcastUpdates may run several times per progress
        // tick and we don't want to write-amp each call.
        await this.ctx.storage.put('lastSpectatorIdx', idx);
      }

      for (const pid of this._meta.playerIds) {
        const playerConns = this.ctx.getWebSockets(pid);
        if (playerConns.length === 0) continue;
        const playerMsg = JSON.stringify(await this.buildPlayerPayload(pid));
        for (const ws of playerConns) {
          try {
            ws.send(playerMsg);
          } catch {}
        }
      }
    } catch (err) {
      // Don't let broadcast errors crash the alarm handler / action pipeline
      console.error('[GameRoomDO] broadcastUpdates failed:', err);
    }
  }

  /**
   * Phase 7.1 — push a unified spectator payload to every spectator WS.
   * Sends a delta (envelopes since `_lastBroadcastRelayIdx`); the
   * payload's `meta.sinceIdx` advances `_lastBroadcastRelayIdx` so the
   * NEXT push is also a delta. Spectators landing fresh receive a full
   * snapshot through `handleWebSocket` — they're never missing context.
   */
  private async broadcastSpectatorPayload(): Promise<void> {
    const conns = this.ctx.getWebSockets(TAG_SPECTATOR);
    if (conns.length === 0) {
      // Still advance the cursor so a future spectator landing (which
      // gets a full snapshot) doesn't cause us to redeliver every
      // envelope on the next bump.
      const tip = await this.getRelayClient().getTip();
      this._lastBroadcastRelayIdx = tip;
      return;
    }
    const payload = await this.buildSpectatorPayload(
      { kind: 'spectator' },
      this._lastBroadcastRelayIdx,
    );
    const json = JSON.stringify(payload);
    for (const ws of conns) {
      try {
        ws.send(json);
      } catch {}
    }
    this._lastBroadcastRelayIdx = payload.meta.sinceIdx;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // State loading
  // ─────────────────────────────────────────────────────────────────────────

  private async ensureLoaded(): Promise<void> {
    if (this._loaded) return;
    await this.ctx.blockConcurrencyWhile(async () => {
      if (this._loaded) return;
      const [
        meta,
        state,
        actionLog,
        progress,
        config,
        snapshotCount,
        lastSpectatorIdx,
        stateVersion,
      ] = await Promise.all([
        this.ctx.storage.get<GameMeta>('meta'),
        this.ctx.storage.get<unknown>('state'),
        this.ctx.storage.get<ActionEntry[]>('actionLog'),
        this.ctx.storage.get<ProgressState>('progress'),
        this.ctx.storage.get<unknown>('config'),
        this.ctx.storage.get<number>('snapshotCount'),
        this.ctx.storage.get<number | null>('lastSpectatorIdx'),
        this.ctx.storage.get<number>('stateVersion'),
      ]);

      // Drop the legacy prevProgressState key from older games.
      this.ctx.storage.delete('prevProgressState').catch(() => {});
      // Phase 4.4: drop the legacy single-array 'relay' key. Envelopes
      // now live under 'relay:<paddedIndex>' + 'relay:tip'. No migration
      // (per the no-backwards-compat rule for pre-launch).
      this.ctx.storage.delete('relay').catch(() => {});
      // Phase 3.2: drop the legacy 'deadline' key from pre-multiplexer games.
      // Deadlines now live in `alarm:queue` as `{ kind: 'deadline', ... }`.
      this.ctx.storage.delete('deadline').catch(() => {});

      if (!meta) {
        this._loaded = true;
        return;
      }

      const plugin = getGame(meta.gameType);
      if (!plugin) {
        console.error(`[GameRoomDO] Unknown game type on load: ${meta.gameType}`);
        this._loaded = true;
        return;
      }

      // Load individual snapshot keys
      const count = snapshotCount ?? 0;
      let loadedSnapshots: unknown[] = [];
      if (count > 0) {
        const snapshotKeys = Array.from({ length: count }, (_, i) => `snapshot:${i}`);
        const snapshotMap = await this.ctx.storage.get<unknown>(snapshotKeys);
        loadedSnapshots = snapshotKeys.map((k) => snapshotMap.get(k)).filter(Boolean) as unknown[];
      }

      // Back-fill for games created before this field was persisted.
      if (typeof meta.spectatorDelay !== 'number') {
        meta.spectatorDelay = plugin.spectatorDelay ?? 0;
      }

      this._meta = meta;
      this._plugin = plugin;
      this._state = state ?? null;
      this._actionLog = actionLog ?? [];
      this._progress = progress ?? { counter: 0 };
      this._stateVersion = stateVersion ?? 0;
      // @ts-expect-error TS2339: Property '_config' does not exist on type 'GameRoomDO'. — TODO(2.3-followup)
      this._config = config ?? null;
      this._spectatorSnapshots = loadedSnapshots;
      // Phase 7.3: restore last broadcast index so a post-hibernation
      // tick doesn't duplicate-broadcast the same snapshot to
      // spectators who already have it.
      this._lastSpectatorIdx = lastSpectatorIdx ?? null;
      this._loaded = true;
    });
  }
}
