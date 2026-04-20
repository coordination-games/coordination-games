/**
 * DOStorageRelayClient — canonical RelayClient backed by raw
 * `DurableObjectStorage`. Used by both LobbyDO and GameRoomDO so the
 * relay log lives in exactly one place with one set of filtering rules.
 *
 * Storage layout:
 *   relay:tip                     → number (next index to assign)
 *   relay:0000000000              → RelayEnvelope (10-digit zero-padded index)
 *   relay:0000000001              → RelayEnvelope
 *   ...
 *
 * The padding gives `storage.list({prefix:'relay:'})` a stable
 * lexicographic order and supports up to 10B envelopes per game/lobby
 * (well above any realistic bound).
 *
 * Why this exists: the previous implementation kept the entire relay
 * array as the value of a single `'relay'` storage key and re-`put` it
 * on every publish — O(n) write-amplification per envelope. The new
 * shape writes exactly two values per `publish()` (the new envelope +
 * the bumped tip) regardless of relay length.
 *
 * Visibility filtering (`visibleTo`, `since`) is centralised here via
 * `isVisible`. Phase 0.1's inline `filterRelayForSpectator` /
 * `filterRelayForPlayer` in LobbyDO and `getVisibleRelay` /
 * `resolveRelayRecipients` in GameRoomDO are SUPERSEDED.
 */

import type { DurableObjectStorage } from '@cloudflare/workers-types';
import type { RelayEnvelope } from '@coordination-games/engine';
import type { RelayClient, SpectatorViewer } from './capabilities.js';

const PADDED_INDEX_LEN = 10; // 10 digits = up to 10B envelopes per game
const RELAY_PREFIX = 'relay:';
const RELAY_TIP_KEY = 'relay:tip';

function paddedKey(index: number): string {
  return `${RELAY_PREFIX}${String(index).padStart(PADDED_INDEX_LEN, '0')}`;
}

export interface RelayClientOpts {
  /**
   * Resolves the team a player belongs to in the current state. Used to
   * filter `scope.kind === 'team'` envelopes for player viewers.
   * Returning `null` means "this player has no team" — team-scoped
   * envelopes are then hidden from them.
   */
  getTeamForPlayer?(playerId: string): string | null;
  /**
   * Resolves the display handle for a player. DM scopes carry a
   * recipient handle on the wire; this lets `isVisible` check both
   * `playerId` and `handle` so callers can identify recipients either
   * way without forcing the resolver to know which form was used.
   */
  getHandleForPlayer?(playerId: string): string | null;
  /** Logs structured events. */
  log?(event: string, data: unknown): void;
}

/**
 * Concrete RelayClient over `DurableObjectStorage`. One instance per DO
 * (the DO IS the relay — we don't namespace under `plugin:` here, the
 * relay log is shared across all plugins serving that game/lobby).
 */
export class DOStorageRelayClient implements RelayClient {
  /** Cached after first load — avoids re-reading the tip on every publish. */
  private nextIndex: number | null = null;
  /** dedupeKey → emitted index. In-memory only; survives DO instance lifetime. */
  private dedupeIndex = new Map<string, number>();

  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly opts: RelayClientOpts = {},
  ) {}

  private async ensureTip(): Promise<number> {
    if (this.nextIndex !== null) return this.nextIndex;
    const tip = await this.storage.get<number>(RELAY_TIP_KEY);
    this.nextIndex = tip ?? 0;
    return this.nextIndex;
  }

  async publish(
    env: Omit<RelayEnvelope, 'index' | 'timestamp'>,
    opts?: { dedupeKey?: string },
  ): Promise<void> {
    if (opts?.dedupeKey && this.dedupeIndex.has(opts.dedupeKey)) {
      this.opts.log?.('relay.dedupe.skip', { dedupeKey: opts.dedupeKey });
      return;
    }
    const tip = await this.ensureTip();
    const full: RelayEnvelope = { ...env, index: tip, timestamp: Date.now() };
    // Bounded write per publish — independent of relay length.
    await this.storage.put(paddedKey(tip), full);
    await this.storage.put(RELAY_TIP_KEY, tip + 1);
    this.nextIndex = tip + 1;
    if (opts?.dedupeKey) this.dedupeIndex.set(opts.dedupeKey, tip);
  }

  async visibleTo(viewer: SpectatorViewer): Promise<RelayEnvelope[]> {
    const all = await this.loadAll();
    return all.filter((env) => isVisible(env, viewer, this.opts));
  }

  async since(index: number, viewer: SpectatorViewer): Promise<RelayEnvelope[]> {
    const startKey = paddedKey(index);
    const map = await this.storage.list<RelayEnvelope>({
      prefix: RELAY_PREFIX,
      start: startKey,
    });
    const arr: RelayEnvelope[] = [];
    for (const [k, v] of map) {
      if (k === RELAY_TIP_KEY) continue;
      arr.push(v);
    }
    arr.sort((a, b) => a.index - b.index);
    return arr.filter((env) => isVisible(env, viewer, this.opts));
  }

  /** Load every envelope (sorted by index). Used for full-history reads. */
  private async loadAll(): Promise<RelayEnvelope[]> {
    const map = await this.storage.list<RelayEnvelope>({ prefix: RELAY_PREFIX });
    const arr: RelayEnvelope[] = [];
    for (const [k, v] of map) {
      if (k === RELAY_TIP_KEY) continue;
      arr.push(v);
    }
    arr.sort((a, b) => a.index - b.index);
    return arr;
  }
}

/**
 * Pure visibility predicate — exported so the few non-storage call sites
 * (test fixtures, in-memory variants) can share the rule with
 * `DOStorageRelayClient`.
 *
 * Rules:
 *   - `admin` viewers see everything.
 *   - `scope.kind === 'all'` envelopes are visible to everyone.
 *   - `spectator` and `replay` viewers only see `'all'` envelopes.
 *   - `player` / `bot` viewers see DMs they sent or received (matched
 *     against playerId AND resolved handle) and team chat for their
 *     team (resolver may return null → hidden).
 */
export function isVisible(
  env: RelayEnvelope,
  viewer: SpectatorViewer,
  opts: Pick<RelayClientOpts, 'getTeamForPlayer' | 'getHandleForPlayer'> = {},
): boolean {
  if (viewer.kind === 'admin') return true;
  if (env.scope.kind === 'all') return true;
  if (viewer.kind === 'spectator' || viewer.kind === 'replay') return false;

  // player or bot
  const playerId = viewer.playerId;

  if (env.scope.kind === 'dm') {
    // Sender always sees their own DM.
    if (env.sender === playerId) return true;
    // Recipient may be addressed by playerId OR display handle.
    if (env.scope.recipientHandle === playerId) return true;
    const handle = opts.getHandleForPlayer?.(playerId);
    if (handle && env.scope.recipientHandle === handle) return true;
    return false;
  }

  if (env.scope.kind === 'team') {
    const team = opts.getTeamForPlayer?.(playerId);
    return team != null && team === env.scope.teamId;
  }

  return false;
}
