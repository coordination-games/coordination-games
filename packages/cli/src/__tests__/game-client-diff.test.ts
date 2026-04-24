/**
 * Unit tests for `GameClient.applyAgentDiff` wiring — Phase 2 of the
 * agent-envelope fix. Asserts:
 *   1. Unscoped calls return raw state (no diff, no `_unchangedKeys`).
 *   2. Scoped calls dedup on the second call through persistence — so a
 *      freshly-spawned process inherits the prior baseline via disk.
 *   3. `setScope(newId)` from an active scope resets cursor + cache +
 *      differ baseline. Without this, a lobby → game transition carries
 *      the lobby's baseline into the first game-state fetch and emits
 *      bogus `_unchangedKeys` across the boundary.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type AgentPersistenceMod = typeof import('../agent-persistence.js');
type GameClientMod = typeof import('../game-client.js');

async function loadFresh(): Promise<{ ap: AgentPersistenceMod; gc: GameClientMod }> {
  vi.resetModules();
  const ap = (await import('../agent-persistence.js')) as AgentPersistenceMod;
  const gc = (await import('../game-client.js')) as GameClientMod;
  return { ap, gc };
}

const TEST_KEY = '0x0000000000000000000000000000000000000000000000000000000000000001';

let home: string;
let origHome: string | undefined;

beforeEach(() => {
  origHome = process.env.HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'coga-game-client-diff-'));
  process.env.HOME = home;
});

afterEach(() => {
  vi.restoreAllMocks();
  if (origHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = origHome;
  }
  try {
    fs.rmSync(home, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup.
  }
});

describe('GameClient applyAgentDiff', () => {
  it('getState without an active scope returns raw state (no diff applied)', async () => {
    const { gc } = await loadFresh();

    const client = new gc.GameClient('http://localhost:8787', {
      token: 'test-token',
      privateKey: TEST_KEY,
    });
    // No setScope call — unscoped mode. The scope rule (Phase 1) says
    // unscoped callers (`coga lobbies`, etc.) must never trigger the diff.

    (client as unknown as { api: unknown }).api = {
      // Return the same payload twice. With a scope active this would
      // collapse everything into `_unchangedKeys` on the second call; with
      // no scope, both should return raw.
      getState: vi.fn(async () => ({ turn: 5, phase: 'move', score: { red: 0, blue: 0 } })),
      resetSessionCursors: vi.fn(),
      setScope: vi.fn(),
      clearScope: vi.fn(),
    };

    const r1 = (await client.getState()) as Record<string, unknown>;
    const r2 = (await client.getState()) as Record<string, unknown>;

    // Both calls return the full raw object. No diff metadata.
    expect(r1).toEqual({ turn: 5, phase: 'move', score: { red: 0, blue: 0 } });
    expect(r2).toEqual({ turn: 5, phase: 'move', score: { red: 0, blue: 0 } });
    expect(r1._unchangedKeys).toBeUndefined();
    expect(r2._unchangedKeys).toBeUndefined();
  });

  it('getState with a scope dedups on the second call via `_unchangedKeys`', async () => {
    const { gc } = await loadFresh();

    const client = new gc.GameClient('http://localhost:8787', {
      token: 'test-token',
      privateKey: TEST_KEY,
    });
    client.setScope('game-diff-1');

    (client as unknown as { api: unknown }).api = {
      getState: vi.fn(async () => ({
        turn: 5,
        phase: 'move',
        mapStatic: { width: 10 },
      })),
      resetSessionCursors: vi.fn(),
      setScope: vi.fn(),
      clearScope: vi.fn(),
    };

    const r1 = (await client.getState()) as Record<string, unknown>;
    const r2 = (await client.getState()) as Record<string, unknown>;

    // First call — full payload, no diff metadata (baseline seed).
    expect(r1.turn).toBe(5);
    expect(r1.phase).toBe('move');
    expect(r1.mapStatic).toEqual({ width: 10 });
    expect(r1._unchangedKeys).toBeUndefined();

    // Second call — identical payload, so every key collapses.
    expect(r2.turn).toBeUndefined();
    expect(r2.phase).toBeUndefined();
    expect(r2.mapStatic).toBeUndefined();
    expect(r2._unchangedKeys).toEqual(expect.arrayContaining(['turn', 'phase', 'mapStatic']));
  });

  it('cross-process: a fresh GameClient inherits the persisted baseline and still dedups', async () => {
    // This is the ACTUAL shipping contract — `coga state` called twice in
    // separate shell processes must dedup. We simulate by constructing
    // two separate GameClient instances against the same tmp HOME and
    // the same `(agent, scope)` key.
    const { gc } = await loadFresh();

    // Process 1 — seed.
    const c1 = new gc.GameClient('http://localhost:8787', {
      token: 'test-token',
      privateKey: TEST_KEY,
    });
    c1.setScope('game-diff-cross');

    const payload = { turn: 7, phase: 'move', score: { red: 1, blue: 1 } };
    (c1 as unknown as { api: unknown }).api = {
      getState: vi.fn(async () => payload),
      resetSessionCursors: vi.fn(),
      setScope: vi.fn(),
      clearScope: vi.fn(),
    };
    const r1 = (await c1.getState()) as Record<string, unknown>;
    expect(r1.turn).toBe(7);
    expect(r1._unchangedKeys).toBeUndefined();

    // Process 2 — fresh instance, same persistence key. Without the disk
    // round-trip this would pass through in full again.
    const c2 = new gc.GameClient('http://localhost:8787', {
      token: 'test-token',
      privateKey: TEST_KEY,
    });
    c2.setScope('game-diff-cross');
    (c2 as unknown as { api: unknown }).api = {
      getState: vi.fn(async () => payload),
      resetSessionCursors: vi.fn(),
      setScope: vi.fn(),
      clearScope: vi.fn(),
    };
    const r2 = (await c2.getState()) as Record<string, unknown>;

    // The second process still dedups — the whole point of persistence.
    expect(r2.turn).toBeUndefined();
    expect(r2._unchangedKeys).toEqual(expect.arrayContaining(['turn', 'phase', 'score']));
  });

  it('setScope(newId) resets cursor + cache + differ baseline', async () => {
    // Simulates the lobby → game transition: the lobby has a stable
    // baseline ({ phase: 'lobby' } etc.), then the session upgrades to
    // the game scope. Without this reset, the first game-state fetch
    // would dedup against the lobby baseline and emit a bogus
    // `_unchangedKeys: ['phase']` line even though the two observations
    // are semantically unrelated.
    const { ap, gc } = await loadFresh();

    const client = new gc.GameClient('http://localhost:8787', {
      token: 'test-token',
      privateKey: TEST_KEY,
    });
    const agent = (client as unknown as { agentAddress: string }).agentAddress;

    const resetSpy = vi.fn();
    (client as unknown as { api: unknown }).api = {
      getState: vi.fn(async () => ({ phase: 'lobby', x: 1 })),
      resetSessionCursors: resetSpy,
      setScope: vi.fn(),
      clearScope: vi.fn(),
    };

    // Establish a lobby baseline.
    client.setScope('lobby-A');
    await client.getState();
    // Baseline got persisted against the lobby.
    expect(ap.read(agent, 'lobby-A')?.lastSeen).toEqual({ phase: 'lobby', x: 1 });

    // Scope change — the lobby cursor/baseline must NOT leak into the
    // game scope's first fetch.
    client.setScope('game-B');

    // `setScope(newId)` when scopes differ calls `api.resetSessionCursors()`.
    // Exactly once for the transition — in-memory reset.
    expect(resetSpy).toHaveBeenCalledTimes(1);

    // The differ's in-memory baseline is cleared. Verify by swapping in a
    // mock api that returns a semantically-unrelated payload; the first
    // fetch must pass through in full, not dedup against the lobby state.
    const gameStateFetch = vi.fn(async () => ({ phase: 'lobby', x: 1, turn: 0 }));
    (client as unknown as { api: unknown }).api = {
      getState: gameStateFetch,
      resetSessionCursors: vi.fn(),
      setScope: vi.fn(),
      clearScope: vi.fn(),
    };

    const first = (await client.getState()) as Record<string, unknown>;
    // Full pass-through — baseline was reset so nothing collapses.
    expect(first).toEqual({ phase: 'lobby', x: 1, turn: 0 });
    expect(first._unchangedKeys).toBeUndefined();
  });

  it('setScope with same id is a no-op (no cursor reset, baseline preserved)', async () => {
    // The common case — `maybeUpgradeScopeFromState` calls `setScope`
    // with the current scopeId on every state response. That must not
    // blow up the baseline every tick.
    const { gc } = await loadFresh();

    const client = new gc.GameClient('http://localhost:8787', {
      token: 'test-token',
      privateKey: TEST_KEY,
    });
    client.setScope('game-same');

    const resetSpy = vi.fn();
    (client as unknown as { api: unknown }).api = {
      getState: vi.fn(async () => ({ turn: 1, phase: 'move' })),
      resetSessionCursors: resetSpy,
      setScope: vi.fn(),
      clearScope: vi.fn(),
    };
    await client.getState();
    // `resetSpy` was NOT called (setScope to same id short-circuits).
    expect(resetSpy).not.toHaveBeenCalled();

    // Manually calling setScope with the same id: still a no-op.
    client.setScope('game-same');
    expect(resetSpy).not.toHaveBeenCalled();

    // Second fetch still dedups because baseline survived.
    const r2 = (await client.getState()) as Record<string, unknown>;
    expect(r2._unchangedKeys).toEqual(expect.arrayContaining(['turn', 'phase']));
  });
});
