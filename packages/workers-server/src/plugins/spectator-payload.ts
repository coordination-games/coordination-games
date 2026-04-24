/**
 * Phase 7.1 — Unified spectator payload builder.
 *
 * Goal: ONE payload shape, TWO transports (HTTP + WS) sharing one code path.
 *
 * Both HTTP `/state` (for unauthenticated spectators) / `/spectator` and WS
 * spectator broadcasts produce a `SpectatorPayload`. The transport is a thin
 * shell — all visibility, fog, snapshot-index gating, and relay filtering
 * lives here on top of `RelayClient.visibleTo` (Phase 4.4) and the per-DO
 * `publicSnapshotIndex` rule.
 *
 * Server-authoritative `sinceIdx` policy:
 *   - Callers may pass `sinceIdx` to ask for incremental relay updates.
 *   - We CLAMP it to the current public relay tip — never trust a future
 *     index. If a caller claims sinceIdx=999 but the tip is 100, we treat
 *     it as 100 (returns no envelopes; meta.sinceIdx echoes 100).
 *   - We also clamp negatives to 0.
 *   - `sinceIdx` operates on the relay envelope-index space, not on
 *     `progressCounter` — those advance independently (chat may publish
 *     several envelopes between two progress ticks).
 *
 * The returned payload's `meta.sinceIdx` is the next-cursor for the caller:
 * it's the highest envelope-index INCLUDED in this payload, or — if no
 * envelopes were included — the current public tip. Either way the next
 * call with `sinceIdx = meta.sinceIdx` is correct.
 */

import type { RelayEnvelope, ToolDefinition } from '@coordination-games/engine';
import type { RelayClient, SpectatorViewer } from './capabilities.js';

export interface SpectatorPayloadMeta {
  /** Game id (or lobby id when used from LobbyDO). */
  gameId: string;
  /** Game type registered with the engine, e.g. 'capture-the-lobster'. */
  gameType: string;
  /** Display-name map for handles in the payload state. */
  handles: Record<string, string>;
  /** Current public progress index, or null if pre-window. */
  progressCounter: number | null;
  /** Whether the underlying game is finished. */
  finished: boolean;
  /**
   * Next-cursor for incremental updates. Equals the highest relay
   * envelope-index INCLUDED in `relay`, or — when `relay` is empty —
   * the current public relay tip. Always server-authoritative (clamped).
   */
  sinceIdx: number;
  /**
   * Monotonic counter that increments whenever viewer-visible game/lobby
   * state actually mutates (phase transitions, action results, alarms,
   * join/disband). Does NOT bump on pure relay publishes (chat) —
   * those ride the `sinceIdx` cursor. Clients echo the last-seen value
   * as `?knownStateVersion=N`; when it matches, the server omits
   * `state`/`currentPhase`/`gameOver` and the client reuses its cache.
   */
  stateVersion: number;
  /** Wall-clock send time (ms epoch) — handy for client-side staleness checks. */
  lastUpdate: number;
}

/**
 * Discriminated payload kind:
 *   - 'state_update'      : a public spectator snapshot is available.
 *   - 'spectator_pending' : the spectator-delay window has not yet elapsed.
 *
 * Same shape on HTTP and WS so the frontend hook handles them uniformly.
 */
export interface SpectatorStateUpdatePayload {
  type: 'state_update';
  meta: SpectatorPayloadMeta;
  /**
   * Game-specific spectator view (`game.buildSpectatorView` output).
   * `null` means "ETag match — reuse your cached state"; see
   * `SpectatorPayloadMeta.stateVersion`.
   */
  state: unknown | null;
  /** Relay envelopes filtered through `RelayClient.visibleTo(viewer)`. */
  relay: RelayEnvelope[];
  /**
   * Auth-only: currently-callable tool surface for this viewer. Populated
   * when the caller supplied an X-Player-Id; absent for spectator callers.
   * For GameRoomDO this is the synthetic `{id:'game', name:'Game', tools}`;
   * for LobbyDO it's the current `LobbyPhase`'s `{id, name, tools}`.
   * Spectator-visible tool metadata stays available inside `state` for
   * lobbies (under `state.currentPhase`) — this field carries the
   * per-viewer authorized surface for CLI dispatch.
   */
  currentPhase?: { id: string; name: string; tools: ToolDefinition[] };
  /**
   * Auth-only: `true` when the underlying game has terminated. Mirrors
   * `meta.finished` but kept as a distinct field so CLI callers can read
   * a single, historically-stable name.
   */
  gameOver?: boolean;
}

export interface SpectatorPendingPayload {
  type: 'spectator_pending';
  meta: SpectatorPayloadMeta;
}

export type SpectatorPayload = SpectatorStateUpdatePayload | SpectatorPendingPayload;

/**
 * Inputs to `buildSpectatorPayload`. The DO is responsible for all the
 * lookups (snapshot, meta, relay tip); this function does the assembly.
 */
export interface BuildSpectatorPayloadCtx {
  gameId: string;
  gameType: string;
  handles: Record<string, string>;
  finished: boolean;
  /**
   * Highest snapshot index a spectator may see, or `null` pre-window.
   * Pre-computed by the DO via `computePublicSnapshotIndex`.
   */
  publicSnapshotIndex: number | null;
  /**
   * The pre-built spectator state for `publicSnapshotIndex` (i.e. the
   * snapshot from `_spectatorSnapshots[publicSnapshotIndex]`). Caller
   * passes `null` iff `publicSnapshotIndex` is `null` (pre-window).
   */
  state: unknown | null;
  /** Viewer identity (controls relay visibility). */
  viewer: SpectatorViewer;
  /** Relay client for the current DO (game- or lobby-scoped). */
  relay: RelayClient;
  /**
   * The current relay tip index (i.e. the next index `publish()` would
   * assign). Used to clamp client-supplied `sinceIdx`. Pass 0 if the
   * relay log is empty.
   */
  relayTip: number;
  /**
   * Optional cursor: include only envelopes with `index >= sinceIdx`.
   * Clamped to `[0, relayTip]` server-side — never trust the client claim.
   * When omitted, returns the full visible relay history. Explicitly
   * accepts `undefined` (rather than only the missing-key form) so DO
   * call sites can forward parsed query strings without an extra branch.
   */
  sinceIdx?: number | undefined;
  /**
   * Current monotonic state-version for the DO. Always included in
   * `meta.stateVersion` so clients can cache + echo it back. See
   * `SpectatorPayloadMeta.stateVersion`.
   */
  stateVersion: number;
  /**
   * Client-echoed last-seen `stateVersion`. When it equals the current
   * `stateVersion`, the payload omits `state`/`currentPhase`/`gameOver`
   * (ETag-style 304) and the client reuses its cached view. Pre-window
   * payloads ignore this (spectator_pending never carries state anyway).
   */
  knownStateVersion?: number | undefined;
  /**
   * Auth-only fields. Pass these in when the viewer is a player; leave
   * undefined for spectator viewers. Carried verbatim onto the payload.
   */
  currentPhase?: { id: string; name: string; tools: ToolDefinition[] };
  gameOver?: boolean;
}

/**
 * Clamp a client-supplied `sinceIdx` to the legal range `[0, relayTip]`.
 * Hoisted as a named export so transport call sites and tests can reach it.
 */
export function clampSinceIdx(claim: number | undefined, relayTip: number): number | undefined {
  if (claim === undefined) return undefined;
  if (!Number.isFinite(claim)) return 0;
  if (claim < 0) return 0;
  if (claim > relayTip) return relayTip;
  return Math.floor(claim);
}

export async function buildSpectatorPayload(
  ctx: BuildSpectatorPayloadCtx,
): Promise<SpectatorPayload> {
  const claim: number | undefined = ctx.sinceIdx;
  const clampedSince = clampSinceIdx(claim, ctx.relayTip);

  const filteredRelay =
    clampedSince !== undefined
      ? await ctx.relay.since(clampedSince, ctx.viewer)
      : await ctx.relay.visibleTo(ctx.viewer);

  // Next-cursor: highest envelope index included, or the relay tip if we
  // returned nothing. Tip is the right "no new data" cursor — a follow-up
  // call with `sinceIdx = tip` returns nothing too.
  const nextCursor =
    filteredRelay.length > 0
      ? (filteredRelay[filteredRelay.length - 1] as RelayEnvelope).index + 1
      : ctx.relayTip;

  const meta: SpectatorPayloadMeta = {
    gameId: ctx.gameId,
    gameType: ctx.gameType,
    handles: ctx.handles,
    progressCounter: ctx.publicSnapshotIndex,
    finished: ctx.finished,
    sinceIdx: nextCursor,
    stateVersion: ctx.stateVersion,
    lastUpdate: Date.now(),
  };

  if (ctx.publicSnapshotIndex === null || ctx.state === null) {
    return { type: 'spectator_pending', meta };
  }

  // ETag short-circuit: client already has this stateVersion cached.
  // Emit an empty-state frame — relay deltas still flow through meta.sinceIdx.
  // `currentPhase` and `gameOver` are omitted because they're viewer-visible
  // state and always change in lockstep with `state` itself.
  if (
    ctx.knownStateVersion !== undefined &&
    Number.isFinite(ctx.knownStateVersion) &&
    ctx.knownStateVersion === ctx.stateVersion
  ) {
    return {
      type: 'state_update',
      meta,
      state: null,
      relay: filteredRelay,
    };
  }

  const payload: SpectatorStateUpdatePayload = {
    type: 'state_update',
    meta,
    state: ctx.state,
    relay: filteredRelay,
  };
  if (ctx.currentPhase !== undefined) payload.currentPhase = ctx.currentPhase;
  if (ctx.gameOver !== undefined) payload.gameOver = ctx.gameOver;
  return payload;
}
