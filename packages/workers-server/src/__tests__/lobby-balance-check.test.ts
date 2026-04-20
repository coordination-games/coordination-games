/**
 * LobbyDO pre-game credit balance check.
 *
 * Locks in the join-time `balance >= entryCost` gate added to
 * `LobbyDO.handleJoin`. The MVP spec is a read-only check against the
 * current on-chain (or mock) balance before appending the player to the
 * lobby roster — no committed-stake ledger, no concurrent-game escrow.
 *
 * Scenarios covered:
 *   1. Balance short of `entryCost` → HTTP 402 with the documented
 *      `{ error, required, available, agentId }` body; no agent is
 *      appended to the lobby roster.
 *   2. Balance exactly meets `entryCost` → join succeeds; the agent is
 *      appended.
 *
 * `plugin.entryCost` is already a raw-unit bigint (declared via `credits(10)`
 * in CtL → `10_000_000n`). No scaling happens in the DO — the type system
 * alone guarantees units match the relay's `getBalance` result.
 *
 * The chain relay is stubbed via `_chainRelayPromise` — no viem, no D1
 * lookup for chain_agent_id (we leave `env.RPC_URL` unset so the MockRelay
 * path is taken, which ignores the agentId arg entirely).
 */

import { CaptureTheLobsterPlugin, CTL_GAME_ID } from '@coordination-games/game-ctl';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChainRelay } from '../chain/types.js';
import { emptyD1, type LobbyDOInternal, makeMemoryStorage, readJson } from './test-helpers.js';

// Stub `cloudflare:workers` so importing LobbyDO under Node/vitest doesn't
// trip on the DurableObject base class. Same approach as
// `lobby-spectator-leak.test.ts`.
vi.mock('cloudflare:workers', () => ({
  DurableObject: class {},
}));

type LobbyDOCtor = { prototype: object };
let LobbyDO: LobbyDOCtor;

beforeAll(async () => {
  ({ LobbyDO } = (await import('../do/LobbyDO.js')) as unknown as { LobbyDO: LobbyDOCtor });
  // Sanity-check the fixture assumption: CtL entryCost is 10 whole credits
  // (= 10_000_000n raw) so the `rawBalance` values below are exactly the
  // gating threshold.
  expect(CaptureTheLobsterPlugin.entryCost).toBe(10_000_000n);
});

/** Minimal ChainRelay stub — only `getBalance` is exercised here. */
function makeBalanceRelay(rawBalance: bigint): ChainRelay {
  const stub = {
    async getBalance() {
      return { credits: rawBalance.toString(), usdc: '0' };
    },
  };
  return stub as unknown as ChainRelay;
}

/**
 * Build a LobbyDO frozen at the start of CtL team-formation (phase index 0,
 * no agents yet) with a stubbed chain relay that reports `rawBalance`.
 */
function buildLobby(rawBalance: bigint): LobbyDOInternal {
  const storage = makeMemoryStorage();
  const lobby = Object.create(LobbyDO.prototype) as LobbyDOInternal;
  lobby._loaded = true;
  lobby.ctx = {
    storage,
    // handleJoin → saveState → broadcastUpdate walks websockets; no real
    // WS connections in the test harness, so an empty array is correct.
    getWebSockets: () => [] as WebSocket[],
    id: { name: 'lobby-balance-check' },
  };
  // env.RPC_URL intentionally unset — takes the dev-mode path that skips
  // the D1 chain_agent_id lookup and passes the raw playerId to
  // relay.getBalance (our stub ignores it).
  lobby.env = { DB: emptyD1() };
  lobby._meta = {
    lobbyId: 'lobby-balance-check',
    gameType: CTL_GAME_ID,
    currentPhaseIndex: 0,
    accumulatedMetadata: {},
    phase: 'lobby',
    deadlineMs: null,
    gameId: null,
    error: null,
    noTimeout: true,
    createdAt: 0,
  };
  lobby._agents = [];
  // team-formation phase init with zero players is fine — CtL's phase
  // builds an empty pending-invite set.
  const teamFormationPhase = CaptureTheLobsterPlugin.lobby?.phases.find(
    (p) => p.id === 'team-formation',
  );
  if (!teamFormationPhase) throw new Error('test setup: team-formation phase missing');
  lobby._phaseState = teamFormationPhase.init([], {});
  // Short-circuit the lazy relay importer with our pre-resolved stub.
  lobby._chainRelayPromise = Promise.resolve(makeBalanceRelay(rawBalance));
  return lobby;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LobbyDO — pre-game credit balance check', () => {
  it('rejects join with 402 when balance < entryCost (raw units)', async () => {
    // 5 whole credits in raw units — below CtL's 10 whole credits entry.
    const lobby = buildLobby(5_000_000n);
    const resp: Response = await lobby.fetch(
      new Request('https://do/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Player-Id': 'player-a' },
        body: JSON.stringify({ handle: 'alice' }),
      }),
    );
    expect(resp.status).toBe(402);
    const body = await readJson(resp);
    expect(body).toEqual({
      error: 'Insufficient credits',
      required: '10000000',
      available: '5000000',
      agentId: 'player-a',
    });
    // Roster must be untouched — the check runs before the agent is pushed.
    expect(lobby._agents).toEqual([]);
  });

  it('allows join when balance exactly meets entryCost (raw units)', async () => {
    // 10 whole credits in raw units — exactly CtL's entry cost.
    const lobby = buildLobby(10_000_000n);
    const resp: Response = await lobby.fetch(
      new Request('https://do/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Player-Id': 'player-a' },
        body: JSON.stringify({ handle: 'alice' }),
      }),
    );
    expect(resp.status).toBe(200);
    const body = await readJson(resp);
    expect(body.ok).toBe(true);
    // Agent appended to the roster — this is the side effect the gate
    // protects; the success path must still produce it.
    expect(lobby._agents).toHaveLength(1);
    expect(lobby._agents[0]).toMatchObject({ id: 'player-a', handle: 'alice' });
  });
});
