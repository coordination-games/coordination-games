/**
 * Unit tests for `GameClient.getState({ fresh })` / `waitForUpdate({ fresh })`.
 *
 * Scope: verify the `fresh` flag on BOTH read paths clears the on-disk
 * persistence entry for the active `(agent, scopeId)` before the fetch — i.e.
 * the shell `--fresh` flag on `coga state` / `coga wait` reaches the same
 * reset logic the MCP `fresh: true` option already had.
 *
 * We swap HOME to a tmpdir (mirroring agent-persistence.test.ts) so the real
 * `agent-persistence` module writes to a disposable file. The internal
 * ApiClient is stubbed on the GameClient instance so `waitForUpdate` /
 * `getState` don't make any network calls.
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

// A fixed test address that ethers.Wallet derives from the key below. We
// don't hard-code the checksum form — we read it off the client post-construct
// to avoid case mismatch (persistence keys by exact string match).
const TEST_KEY = '0x0000000000000000000000000000000000000000000000000000000000000001';

let home: string;
let origHome: string | undefined;

beforeEach(() => {
  origHome = process.env.HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'coga-game-client-fresh-'));
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

describe('GameClient fresh flag', () => {
  it('getState({ fresh: true }) clears the on-disk (agent, scope) entry before fetching', async () => {
    const { ap, gc } = await loadFresh();

    const client = new gc.GameClient('http://localhost:8787', {
      token: 'test-token',
      privateKey: TEST_KEY,
    });
    // Pull the agent address off the client the same way agent-persistence
    // will see it (whatever case ethers produces — usually checksummed).
    const agent = (client as unknown as { agentAddress: string }).agentAddress;
    expect(typeof agent).toBe('string');

    client.setScope('game-fresh-1');

    // Seed an entry that `fresh: true` should wipe.
    ap.write(agent, 'game-fresh-1', { relayCursor: 99, lastSeen: { marker: 'pre-fresh' } });
    expect(ap.read(agent, 'game-fresh-1')).not.toBeNull();

    // Stub the internal ApiClient so no network happens. `getState` returns
    // an empty envelope — enough for processResponse to run without crashing.
    (client as unknown as { api: unknown }).api = {
      getState: vi.fn(async () => ({}) as Record<string, unknown>),
      resetSessionCursors: vi.fn(),
      setScope: vi.fn(),
      clearScope: vi.fn(),
    };

    await client.getState({ fresh: true });

    // The on-disk entry for the active scope is gone.
    expect(ap.read(agent, 'game-fresh-1')).toBeNull();
    // And the in-memory session cursors were reset via ApiClient.
    const api = (client as unknown as { api: { resetSessionCursors: ReturnType<typeof vi.fn> } })
      .api;
    expect(api.resetSessionCursors).toHaveBeenCalledTimes(1);
  });

  it('waitForUpdate({ fresh: true }) clears the on-disk entry and resets session cursors', async () => {
    const { ap, gc } = await loadFresh();

    const client = new gc.GameClient('http://localhost:8787', {
      token: 'test-token',
      privateKey: TEST_KEY,
    });
    const agent = (client as unknown as { agentAddress: string }).agentAddress;
    expect(typeof agent).toBe('string');

    client.setScope('game-fresh-2');

    ap.write(agent, 'game-fresh-2', { relayCursor: 17, lastSeen: { marker: 'pre-wait' } });
    expect(ap.read(agent, 'game-fresh-2')).not.toBeNull();

    // Stub ApiClient. waitForUpdate returns an empty envelope.
    (client as unknown as { api: unknown }).api = {
      waitForUpdate: vi.fn(async () => ({}) as Record<string, unknown>),
      resetSessionCursors: vi.fn(),
      setScope: vi.fn(),
      clearScope: vi.fn(),
    };

    await client.waitForUpdate({ fresh: true });

    expect(ap.read(agent, 'game-fresh-2')).toBeNull();
    const api = (
      client as unknown as {
        api: {
          resetSessionCursors: ReturnType<typeof vi.fn>;
          waitForUpdate: ReturnType<typeof vi.fn>;
        };
      }
    ).api;
    expect(api.resetSessionCursors).toHaveBeenCalledTimes(1);
    expect(api.waitForUpdate).toHaveBeenCalledTimes(1);
  });

  it('waitForUpdate() without fresh does NOT touch persistence', async () => {
    const { ap, gc } = await loadFresh();

    const client = new gc.GameClient('http://localhost:8787', {
      token: 'test-token',
      privateKey: TEST_KEY,
    });
    const agent = (client as unknown as { agentAddress: string }).agentAddress;
    client.setScope('game-fresh-3');

    ap.write(agent, 'game-fresh-3', { relayCursor: 7, lastSeen: { marker: 'keep' } });

    (client as unknown as { api: unknown }).api = {
      waitForUpdate: vi.fn(async () => ({}) as Record<string, unknown>),
      resetSessionCursors: vi.fn(),
      setScope: vi.fn(),
      clearScope: vi.fn(),
    };

    await client.waitForUpdate();

    // Entry still there — default waitForUpdate must not clear it.
    expect(ap.read(agent, 'game-fresh-3')).toEqual({
      relayCursor: 7,
      lastSeen: { marker: 'keep' },
    });
    const api = (
      client as unknown as {
        api: { resetSessionCursors: ReturnType<typeof vi.fn> };
      }
    ).api;
    expect(api.resetSessionCursors).not.toHaveBeenCalled();
  });
});
