/**
 * LobbyDO relay-leak invariant — privacy fix (Phase 0.1 of cleanup plan).
 *
 * Spectator-facing emission boundaries (HTTP `/state` without an
 * `X-Player-Id` header, and the WS broadcast) must NOT leak relay
 * envelopes whose `scope !== 'all'`. Player-authenticated requests
 * continue to see team-scoped + DM messages addressed to that player.
 *
 * The implementation under test is the inline filter pair in
 * `LobbyDO.ts` (`filterRelayForSpectator` + `filterRelayForPlayer`).
 * Phase 4.4 will collapse these into a shared `RelayClient.visibleTo`,
 * at which point this test moves with the helper.
 *
 * The DO is constructed via `Object.create(prototype)` so we can skip
 * the `DurableObject` ctor entirely — the filter logic only depends on
 * `_meta`, `_agents`, `_phaseState`, `_relay`, and the registered game
 * plugin's lobby phase. No `ctx` / `env` access on the paths exercised
 * here.
 */

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

/** Build a LobbyDO instance frozen mid-team-formation with two formed teams:
 *  team_1 = {p1, p2}, team_2 = {p3, p4}. Then plant a representative relay
 *  history covering all scopes so the filters have something to do. */
function buildLobbyAtTeamFormation() {
  // Skip the DurableObject constructor — we never touch ctx/env on the
  // code paths under test.
  // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
  const lobby: any = Object.create(LobbyDO.prototype);
  lobby._loaded = true;
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
  lobby._spectatorFilterDrops = 0;

  // Drive the real phase through propose+accept so getTeamForPlayer
  // returns truthful answers for both teams.
  let state = teamFormationPhase.init(PLAYERS, {});
  // p1 invites p2 → team_1 created with p1 as member, p2 as invitee.
  state = teamFormationPhase.handleAction(
    state,
    { type: 'propose_team', playerId: 'p1', payload: { targetHandle: 'bob' } },
    PLAYERS,
  ).state;
  // p2 accepts team_1.
  state = teamFormationPhase.handleAction(
    state,
    { type: 'accept_team', playerId: 'p2', payload: { teamId: 'team_1' } },
    PLAYERS,
  ).state;
  // p3 invites p4 → team_2.
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

  // Seed a representative relay log: one public, one team-A, one team-B,
  // and one DM-style envelope (scope.kind 'dm' goes to sender + recipient).
  lobby._relay = [
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
    // Observability: at least one non-'all' envelope was dropped.
    expect(lobby._spectatorFilterDrops).toBeGreaterThan(0);
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
    // p1 must see: own public 'all' (sender p1), own team-A team msg (sender p1),
    // own DM (sender p1). Must NOT see: p3's team-B message.
    expect(scopes).toContain('all:p1');
    expect(scopes).toContain('team:p1');
    expect(scopes).toContain('dm:p1');
    // No team-scoped from p3 (team B sender) — that envelope is filtered out.
    // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred
    const teamFromP3 = body.relay.filter((m: any) => m.scope.kind === 'team' && m.sender === 'p3');
    expect(teamFromP3).toEqual([]);
    // Spectator-drop counter is NOT incremented on the player path.
    expect(lobby._spectatorFilterDrops).toBe(0);
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
