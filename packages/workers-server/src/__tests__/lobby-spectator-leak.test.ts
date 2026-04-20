/**
 * LobbyDO relay-leak invariant.
 *
 * Spectator-facing emission boundaries (HTTP `/state` without an
 * `X-Player-Id` header, and the WS broadcast) must NOT leak relay
 * envelopes whose `scope.kind !== 'all'`. Player-authenticated requests
 * continue to see team-scoped + DM messages addressed to that player.
 *
 * Phase 4.4 replaced Phase 0.1's inline filter pair with the canonical
 * `DOStorageRelayClient`. The envelopes now live in DO storage under
 * `relay:<paddedIndex>` keys, so the fixture seeds them there and stubs
 * `ctx.storage` with an in-memory map.
 */

import type { DurableObjectStorage } from '@cloudflare/workers-types';
import { beforeAll, describe, expect, it, vi } from 'vitest';

// Stub the `cloudflare:workers` module so importing LobbyDO does not
// blow up under Node-based vitest. The `DurableObject` base class is
// only used as `extends DurableObject<Env>`; the test never invokes the
// real constructor (we use `Object.create(prototype)` below).
vi.mock('cloudflare:workers', () => ({
  DurableObject: class {},
}));

// Lazy import — must come after vi.mock above.
// biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
let LobbyDO: any;
// biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
let teamFormationPhase: any;

beforeAll(async () => {
  ({ LobbyDO } = await import('../do/LobbyDO.js'));
  // Pull the real CtL team-formation phase so getTeamForPlayer is
  // exercised against the registered plugin shape.
  const ctl = await import('@coordination-games/game-ctl');
  teamFormationPhase = ctl.CaptureTheLobsterPlugin.lobby?.phases.find(
    // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
    (p: any) => p.id === 'team-formation',
  );
  if (!teamFormationPhase) throw new Error('test setup: team-formation phase not found');
});

// ---------------------------------------------------------------------------
// Fixture builder
// ---------------------------------------------------------------------------

const PLAYERS = [
  { id: 'p1', handle: 'alice' },
  { id: 'p2', handle: 'bob' },
  { id: 'p3', handle: 'carol' },
  { id: 'p4', handle: 'dave' },
];

const PADDED_INDEX_LEN = 10;

function padded(index: number): string {
  return `relay:${String(index).padStart(PADDED_INDEX_LEN, '0')}`;
}

/** Minimal in-memory DurableObjectStorage — only the methods the relay
 *  client and LobbyDO hit in the spectator-leak code path. */
function makeMemoryStorage(): DurableObjectStorage {
  const map = new Map<string, unknown>();
  // biome-ignore lint/suspicious/noExplicitAny: stub satisfies the subset under test
  const stub: any = {
    async get(keyOrKeys: string | string[]): Promise<unknown> {
      if (Array.isArray(keyOrKeys)) {
        const out = new Map<string, unknown>();
        for (const k of keyOrKeys) if (map.has(k)) out.set(k, map.get(k));
        return out;
      }
      return map.get(keyOrKeys);
    },
    async put(key: string, value: unknown): Promise<void> {
      map.set(key, value);
    },
    async delete(key: string): Promise<boolean> {
      return map.delete(key);
    },
    async list(opts?: { prefix?: string; start?: string }): Promise<Map<string, unknown>> {
      const prefix = opts?.prefix ?? '';
      const start = opts?.start;
      const keys = [...map.keys()].sort();
      const out = new Map<string, unknown>();
      for (const k of keys) {
        if (prefix && !k.startsWith(prefix)) continue;
        if (start && k < start) continue;
        out.set(k, map.get(k));
      }
      return out;
    },
  };
  return stub as DurableObjectStorage;
}

/** Build a LobbyDO instance frozen mid-team-formation with two formed teams.
 *  Seeds a representative relay log (public + both teams + DM) into the
 *  stubbed DO storage so the real `DOStorageRelayClient` filters it. */
function buildLobbyAtTeamFormation() {
  const storage = makeMemoryStorage();
  // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
  const lobby: any = Object.create(LobbyDO.prototype);
  lobby._loaded = true;
  lobby.ctx = { storage };
  lobby._meta = {
    lobbyId: 'lobby-test-1',
    gameType: 'capture-the-lobster',
    currentPhaseIndex: 0,
    accumulatedMetadata: {},
    phase: 'running',
    deadlineMs: null,
    gameId: null,
    error: null,
    noTimeout: true,
    createdAt: 0,
  };
  lobby._agents = PLAYERS.map((p) => ({ id: p.id, handle: p.handle, elo: 1000, joinedAt: 0 }));

  // Drive the real phase through propose+accept so getTeamForPlayer
  // returns truthful answers for both teams.
  let state = teamFormationPhase.init(PLAYERS, {});
  state = teamFormationPhase.handleAction(
    state,
    { type: 'propose_team', playerId: 'p1', payload: { targetHandle: 'bob' } },
    PLAYERS,
  ).state;
  state = teamFormationPhase.handleAction(
    state,
    { type: 'accept_team', playerId: 'p2', payload: { teamId: 'team_1' } },
    PLAYERS,
  ).state;
  state = teamFormationPhase.handleAction(
    state,
    { type: 'propose_team', playerId: 'p3', payload: { targetHandle: 'dave' } },
    PLAYERS,
  ).state;
  state = teamFormationPhase.handleAction(
    state,
    { type: 'accept_team', playerId: 'p4', payload: { teamId: 'team_2' } },
    PLAYERS,
  ).state;
  lobby._phaseState = state;

  // Sanity-check the fixture's team membership before we depend on it.
  const t1 = teamFormationPhase.getTeamForPlayer(state, 'p1');
  const t2 = teamFormationPhase.getTeamForPlayer(state, 'p3');
  if (!t1 || !t2 || t1 === t2) {
    throw new Error(`test setup: expected two distinct teams, got ${t1} / ${t2}`);
  }

  // Seed a representative relay log directly in the storage stub. Four
  // envelopes: public, team-A, team-B, and a DM from p1 to p1's handle.
  const envs = [
    {
      index: 0,
      type: 'messaging',
      data: { msg: 'public hi' },
      scope: { kind: 'all' },
      pluginId: 'chat',
      sender: 'p1',
      turn: null,
      timestamp: 1,
    },
    {
      index: 1,
      type: 'messaging',
      data: { msg: 'team-A only' },
      scope: { kind: 'team', teamId: t1 },
      pluginId: 'chat',
      sender: 'p1',
      turn: null,
      timestamp: 2,
    },
    {
      index: 2,
      type: 'messaging',
      data: { msg: 'team-B only' },
      scope: { kind: 'team', teamId: t2 },
      pluginId: 'chat',
      sender: 'p3',
      turn: null,
      timestamp: 3,
    },
    {
      index: 3,
      type: 'messaging',
      data: { msg: 'private dm to p1 from p1' },
      scope: { kind: 'dm', recipientHandle: 'alice' },
      pluginId: 'chat',
      sender: 'p1',
      turn: null,
      timestamp: 4,
    },
  ];
  for (const env of envs) {
    // Synchronous put — stub awaits internally, but we don't need to await
    // here since the Map set is instant. Kept as await for parity.
    storage.put(padded(env.index), env);
  }
  storage.put('relay:tip', envs.length);

  return lobby;
}

// ---------------------------------------------------------------------------
// Tests — the only reason this file exists
// ---------------------------------------------------------------------------

describe('LobbyDO relay leak — spectator vs player filter', () => {
  it('GET /state with NO X-Player-Id returns only scope.kind:"all" envelopes', async () => {
    const lobby = buildLobbyAtTeamFormation();
    const resp: Response = await lobby.fetch(new Request('https://do/state', { method: 'GET' }));
    expect(resp.status).toBe(200);
    // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred
    const body: any = await resp.json();
    expect(Array.isArray(body.relay)).toBe(true);
    expect(body.relay.length).toBe(1); // only the public envelope
    for (const m of body.relay) {
      expect(m.scope.kind).toBe('all');
    }
  });

  it('GET /state with X-Player-Id=p1 (team A) hides team-B envelopes', async () => {
    const lobby = buildLobbyAtTeamFormation();
    const resp: Response = await lobby.fetch(
      new Request('https://do/state', {
        method: 'GET',
        headers: { 'X-Player-Id': 'p1' },
      }),
    );
    expect(resp.status).toBe(200);
    // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred
    const body: any = await resp.json();
    // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred
    const scopes = body.relay.map((m: any) => `${m.scope.kind}:${m.sender}`);
    // p1 must see: own public 'all', own team-A, own DM. Must NOT see team-B.
    expect(scopes).toContain('all:p1');
    expect(scopes).toContain('team:p1');
    expect(scopes).toContain('dm:p1');
    // No team-scoped from p3 (team B sender) — that envelope is filtered out.
    // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred
    const teamFromP3 = body.relay.filter((m: any) => m.scope.kind === 'team' && m.sender === 'p3');
    expect(teamFromP3).toEqual([]);
  });

  it('GET /state with X-Player-Id=p3 (team B) hides team-A envelopes', async () => {
    const lobby = buildLobbyAtTeamFormation();
    const resp: Response = await lobby.fetch(
      new Request('https://do/state', {
        method: 'GET',
        headers: { 'X-Player-Id': 'p3' },
      }),
    );
    // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred
    const body: any = await resp.json();
    const teamScopedFromP1 = body.relay.filter(
      // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred
      (m: any) => m.scope.kind === 'team' && m.sender === 'p1',
    );
    expect(teamScopedFromP1).toEqual([]);
    // But p3 sees their own team-B team message.
    const teamScopedFromP3 = body.relay.filter(
      // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred
      (m: any) => m.scope.kind === 'team' && m.sender === 'p3',
    );
    expect(teamScopedFromP3.length).toBe(1);
  });
});
