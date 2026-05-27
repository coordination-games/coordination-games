/**
 * LobbyDO ghost-player gate.
 *
 * Locks in the outer-guard `acceptsJoins` check added to `LobbyDO.handleJoin`.
 * The prior behaviour pushed agents into `_agents` first and only consulted
 * `phase.acceptsJoins` _after_ the push, so a join arriving during a
 * non-joinable phase (e.g. CtL's ClassSelectionPhase) created a roster entry
 * the phase couldn't see — the ghost-player bug from
 * `docs/plans/sizing-bugs.md` §B2.
 *
 * Scenarios covered:
 *   1. Joining a lobby whose current phase has `acceptsJoins: false` is
 *      rejected with HTTP 409 and `_agents` stays untouched.
 *   2. Joining a lobby whose current phase has `acceptsJoins: true` succeeds
 *      and the agent lands on the roster.
 */

import { CaptureTheLobsterPlugin, CTL_GAME_ID } from '@coordination-games/game-ctl';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChainRelay } from '../chain/types.js';
import { emptyD1, type LobbyDOInternal, makeMemoryStorage, readJson } from './test-helpers.js';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {},
}));

type LobbyDOCtor = { prototype: object };
let LobbyDO: LobbyDOCtor;

beforeAll(async () => {
  ({ LobbyDO } = (await import('../do/LobbyDO.js')) as unknown as { LobbyDO: LobbyDOCtor });
});

function makeAlwaysAllowedRelay(): ChainRelay {
  const stub = {
    async getBalance() {
      return { credits: (10n ** 18n).toString(), usdc: '0' };
    },
  };
  return stub as unknown as ChainRelay;
}

/**
 * Build a LobbyDO frozen on a chosen CtL phase index. CtL has two phases:
 *   0 = team-formation     (acceptsJoins: true)
 *   1 = class-selection    (acceptsJoins: false)  ← ghost-player trap
 */
function buildLobbyAtPhase(phaseIndex: number): LobbyDOInternal {
  const storage = makeMemoryStorage();
  const lobby = Object.create(LobbyDO.prototype) as LobbyDOInternal;
  lobby._loaded = true;
  lobby.ctx = {
    storage,
    getWebSockets: () => [] as WebSocket[],
    id: { name: 'lobby-ghost-gate' },
  };
  lobby.env = { DB: emptyD1() };
  lobby._meta = {
    lobbyId: 'lobby-ghost-gate',
    gameType: CTL_GAME_ID,
    currentPhaseIndex: phaseIndex,
    accumulatedMetadata: {},
    phase: 'lobby',
    deadlineMs: null,
    gameId: null,
    error: null,
    noTimeout: true,
    createdAt: 0,
  };
  lobby._agents = [];
  const phase = CaptureTheLobsterPlugin.lobby?.phases[phaseIndex];
  if (!phase) throw new Error(`test setup: CtL phase ${phaseIndex} missing`);
  lobby._phaseState = phase.init([], {});
  lobby._chainRelayPromise = Promise.resolve(makeAlwaysAllowedRelay());
  return lobby;
}

describe('LobbyDO — ghost-player gate', () => {
  it('rejects joins during a non-joinable phase (acceptsJoins=false) without touching _agents', async () => {
    // Phase index 1 = ClassSelectionPhase (acceptsJoins: false).
    const lobby = buildLobbyAtPhase(1);
    const resp: Response = await lobby.fetch(
      new Request('https://do/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Player-Id': 'ghost-player' },
        body: JSON.stringify({ handle: 'spook' }),
      }),
    );
    expect(resp.status).toBe(409);
    const body = await readJson(resp);
    expect(body.error).toMatch(/not accepting joins/i);
    // _agents must be untouched — the gate runs before the push.
    expect(lobby._agents).toEqual([]);
  });

  it('allows joins during a joinable phase (acceptsJoins=true) and appends to _agents', async () => {
    // Phase index 0 = TeamFormationPhase (acceptsJoins: true).
    const lobby = buildLobbyAtPhase(0);
    const resp: Response = await lobby.fetch(
      new Request('https://do/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Player-Id': 'real-player' },
        body: JSON.stringify({ handle: 'alice' }),
      }),
    );
    expect(resp.status).toBe(200);
    expect(lobby._agents).toHaveLength(1);
    expect(lobby._agents[0]).toMatchObject({ id: 'real-player', handle: 'alice' });
  });
});
