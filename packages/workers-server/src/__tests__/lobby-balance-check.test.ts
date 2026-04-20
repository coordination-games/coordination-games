/**
 * LobbyDO pre-game credit balance check.
 *
 * Locks in the join-time `balance >= entryCost * CREDIT_SCALE` gate added to
 * `LobbyDO.handleJoin`. The MVP spec is a read-only check against the
 * current on-chain (or mock) balance before appending the player to the
 * lobby roster — no committed-stake ledger, no concurrent-game escrow.
 *
 * Scenarios covered:
 *   1. Balance short of `entryCost * CREDIT_SCALE` → HTTP 402 with the
 *      documented `{ error, required, available, agentId }` body; no agent
 *      is appended to the lobby roster.
 *   2. Balance exactly meets `entryCost * CREDIT_SCALE` → join succeeds;
 *      the agent is appended.
 *
 * Uses the real CtL plugin so `entryCost: 10 whole credits → 10_000_000n
 * raw units` is exercised end-to-end (same scale boundary that
 * `GameRoomDO.kickOffSettlement` uses for settlement deltas).
 *
 * The chain relay is stubbed via `_chainRelayPromise` — no viem, no D1
 * lookup for chain_agent_id (we leave `env.RPC_URL` unset so the MockRelay
 * path is taken, which ignores the agentId arg entirely).
 */

import type { D1Database, DurableObjectStorage } from '@cloudflare/workers-types';
import { CaptureTheLobsterPlugin, CTL_GAME_ID } from '@coordination-games/game-ctl';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChainRelay } from '../chain/types.js';

// Stub `cloudflare:workers` so importing LobbyDO under Node/vitest doesn't
// trip on the DurableObject base class. Same approach as
// `lobby-spectator-leak.test.ts`.
vi.mock('cloudflare:workers', () => ({
  DurableObject: class {},
}));

// biome-ignore lint/suspicious/noExplicitAny: lazy import under vi.mock; typed on first use
let LobbyDO: any;

beforeAll(async () => {
  ({ LobbyDO } = await import('../do/LobbyDO.js'));
  // Sanity-check the fixture assumption: CtL entryCost must be 10 whole
  // credits so `10_000_000n` (below) is exactly the gating threshold.
  expect(CaptureTheLobsterPlugin.entryCost).toBe(10);
});

// ---------------------------------------------------------------------------
// In-memory stubs — only the surface the balance-check path touches.
// ---------------------------------------------------------------------------

function makeMemoryStorage(): DurableObjectStorage {
  const map = new Map<string, unknown>();
  // biome-ignore lint/suspicious/noExplicitAny: test-only stub, subset of DurableObjectStorage
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
    async list(opts?: { prefix?: string }): Promise<Map<string, unknown>> {
      const prefix = opts?.prefix ?? '';
      const out = new Map<string, unknown>();
      for (const [k, v] of map.entries()) {
        if (!prefix || k.startsWith(prefix)) out.set(k, v);
      }
      return out;
    },
    async setAlarm(_when: number): Promise<void> {},
    async deleteAlarm(): Promise<void> {},
  };
  return stub as DurableObjectStorage;
}

/** Minimal ChainRelay stub — only `getBalance` is exercised here. */
function makeBalanceRelay(rawBalance: bigint): ChainRelay {
  // biome-ignore lint/suspicious/noExplicitAny: all other ChainRelay methods are irrelevant to this test
  const stub: any = {
    async getBalance() {
      return { credits: rawBalance.toString(), usdc: '0' };
    },
  };
  return stub as ChainRelay;
}

/**
 * Build a LobbyDO frozen at the start of CtL team-formation (phase index 0,
 * no agents yet) with a stubbed chain relay that reports `rawBalance`.
 */
function buildLobby(rawBalance: bigint) {
  const storage = makeMemoryStorage();
  // biome-ignore lint/suspicious/noExplicitAny: test fixture — reaches into private fields
  const lobby: any = Object.create(LobbyDO.prototype);
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
  lobby.env = { DB: {} as D1Database };
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
  it('rejects join with 402 when balance < entryCost * CREDIT_SCALE', async () => {
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
    // biome-ignore lint/suspicious/noExplicitAny: test-only any on JSON body
    const body: any = await resp.json();
    expect(body).toEqual({
      error: 'Insufficient credits',
      required: '10000000',
      available: '5000000',
      agentId: 'player-a',
    });
    // Roster must be untouched — the check runs before the agent is pushed.
    expect(lobby._agents).toEqual([]);
  });

  it('allows join when balance exactly meets entryCost * CREDIT_SCALE', async () => {
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
    // biome-ignore lint/suspicious/noExplicitAny: test-only any on JSON body
    const body: any = await resp.json();
    expect(body.ok).toBe(true);
    // Agent appended to the roster — this is the side effect the gate
    // protects; the success path must still produce it.
    expect(lobby._agents).toHaveLength(1);
    expect(lobby._agents[0]).toMatchObject({ id: 'player-a', handle: 'alice' });
  });
});
