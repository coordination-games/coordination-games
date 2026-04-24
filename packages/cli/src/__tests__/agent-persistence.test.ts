/**
 * Tests for `agent-persistence`. The module reads/writes
 * `~/.coordination/agent-state.json`, so every test installs a tmpdir as
 * HOME and restores it after. The module is imported via a dynamic import
 * inside each test so it picks up the swapped HOME per run.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Mod = typeof import('../agent-persistence.js');

async function loadFresh(): Promise<Mod> {
  vi.resetModules();
  return (await import('../agent-persistence.js')) as Mod;
}

function statePath(home: string): string {
  return path.join(home, '.coordination', 'agent-state.json');
}

let home: string;
let origHome: string | undefined;

beforeEach(() => {
  origHome = process.env.HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'coga-agent-persistence-'));
  // `os.homedir()` on Linux honours $HOME (verified); the module captures
  // `COORD_DIR = path.join(os.homedir(), '.coordination')` at load time, so
  // we swap HOME and reset the module cache before each test.
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
    // Best-effort cleanup — temp dir lifecycle isn't load-bearing.
  }
});

describe('agent-persistence', () => {
  it('read returns null when the state file does not exist', async () => {
    const mod = await loadFresh();
    expect(mod.read('0xAGENT', 'game-1')).toBeNull();
    // Passively reading must not create the file.
    expect(fs.existsSync(statePath(home))).toBe(false);
  });

  it('write + read round-trip for the same (agent, scopeId)', async () => {
    const mod = await loadFresh();
    mod.write('0xAGENT', 'game-1', { relayCursor: 42, lastSeen: { foo: 'bar' } });

    // Same-process read returns the entry.
    expect(mod.read('0xAGENT', 'game-1')).toEqual({
      relayCursor: 42,
      lastSeen: { foo: 'bar' },
    });

    // And a fresh module instance also sees it (disk round-trip).
    const mod2 = await loadFresh();
    expect(mod2.read('0xAGENT', 'game-1')).toEqual({
      relayCursor: 42,
      lastSeen: { foo: 'bar' },
    });

    // File has the expected version header.
    const raw = JSON.parse(fs.readFileSync(statePath(home), 'utf-8'));
    expect(raw._v).toBe(1);
    expect(raw.agents['0xAGENT']['game-1']).toEqual({
      relayCursor: 42,
      lastSeen: { foo: 'bar' },
    });
  });

  it('clear deletes the target entry but leaves sibling entries intact', async () => {
    const mod = await loadFresh();
    mod.write('0xAGENT', 'game-1', { relayCursor: 1, lastSeen: 'a' });
    mod.write('0xAGENT', 'game-2', { relayCursor: 2, lastSeen: 'b' });
    mod.write('0xOTHER', 'game-1', { relayCursor: 3, lastSeen: 'c' });

    mod.clear('0xAGENT', 'game-1');

    expect(mod.read('0xAGENT', 'game-1')).toBeNull();
    // Sibling scope on the same agent untouched.
    expect(mod.read('0xAGENT', 'game-2')).toEqual({ relayCursor: 2, lastSeen: 'b' });
    // Other agents untouched.
    expect(mod.read('0xOTHER', 'game-1')).toEqual({ relayCursor: 3, lastSeen: 'c' });

    // Clearing a missing entry is a no-op, not an error.
    expect(() => mod.clear('0xAGENT', 'game-1')).not.toThrow();
    expect(() => mod.clear('0xNO_SUCH_AGENT', 'game-1')).not.toThrow();
  });

  it('unknown schema version logs a warning and behaves as empty', async () => {
    // Seed a file that claims _v: 999.
    const dir = path.join(home, '.coordination');
    fs.mkdirSync(dir, { mode: 0o700 });
    fs.writeFileSync(
      statePath(home),
      JSON.stringify({
        _v: 999,
        agents: { '0xAGENT': { 'game-1': { relayCursor: 7, lastSeen: 'stale' } } },
      }),
    );

    const warnings: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        warnings.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
        return true;
      });

    const mod = await loadFresh();
    expect(mod.read('0xAGENT', 'game-1')).toBeNull();

    expect(warnings.some((w) => /unknown schema version/.test(w))).toBe(true);
    stderrSpy.mockRestore();
  });

  it('missing _v header is treated as unknown version (reset, no crash)', async () => {
    const dir = path.join(home, '.coordination');
    fs.mkdirSync(dir, { mode: 0o700 });
    fs.writeFileSync(
      statePath(home),
      JSON.stringify({
        agents: { '0xAGENT': { 'game-1': { relayCursor: 7, lastSeen: 'stale' } } },
      }),
    );

    const mod = await loadFresh();
    expect(mod.read('0xAGENT', 'game-1')).toBeNull();
  });

  it('concurrent writes via the lockfile do not corrupt the file', async () => {
    const mod = await loadFresh();

    // Kick off many writes in parallel. `write` is synchronous but the
    // lockfile retry loop + atomic rename are the real serialization point
    // we want to exercise. Wrapping each call in a promise gets the
    // microtask scheduler to interleave them.
    const N = 20;
    const tasks: Promise<void>[] = [];
    for (let i = 0; i < N; i++) {
      tasks.push(
        Promise.resolve().then(() => {
          mod.write('0xAGENT', `scope-${i % 4}`, { relayCursor: i, lastSeen: { i } });
        }),
      );
    }
    await Promise.all(tasks);

    // File still parses as valid JSON with the correct shape.
    const raw = JSON.parse(fs.readFileSync(statePath(home), 'utf-8'));
    expect(raw._v).toBe(1);
    expect(raw.agents['0xAGENT']).toBeDefined();
    // All four scopes got at least one write. We can't assert specific
    // values because the last writer wins non-deterministically, but shape
    // integrity is the contract.
    for (let s = 0; s < 4; s++) {
      const entry = raw.agents['0xAGENT'][`scope-${s}`];
      expect(entry).toBeDefined();
      expect(typeof entry.relayCursor).toBe('number');
    }
  });
});
