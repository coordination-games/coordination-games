/**
 * Per-agent, per-scope persisted state for the CLI.
 *
 * Phase 1 of the agent-envelope fix (see `docs/plans/agent-envelope-fix.md`).
 * This module owns the on-disk store at `~/.coordination/agent-state.json`.
 *
 * Shape on disk:
 *   {
 *     "_v": 1,
 *     "agents": {
 *       "<agentAddress>": {
 *         "<scopeId>": {
 *           "relayCursor": 42,
 *           "lastSeen": null        // Phase 2 will populate this
 *         }
 *       }
 *     }
 *   }
 *
 * Scope rule (enforced by callers, not this module): only game/lobby-scoped
 * calls hit persistence. Unscoped commands (`coga lobbies`, `coga wallet`,
 * identity/trust) must not call in. `scopeId` here is always a non-null
 * string — the active game-or-lobby ID.
 *
 * Concurrency: `proper-lockfile` advisory lock around every read-modify-write.
 * Atomic writes via tmp + rename so a crash mid-write can't truncate the
 * real file. Unknown `_v` resets the file (with a stderr warning).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import lockfile from 'proper-lockfile';

const COORD_DIR = path.join(os.homedir(), '.coordination');
const STATE_PATH = path.join(COORD_DIR, 'agent-state.json');
const TMP_PATH = `${STATE_PATH}.tmp`;
const LOCK_PATH = `${STATE_PATH}.lock`;

const SCHEMA_VERSION = 1;

export type PersistedEntry = { relayCursor: number; lastSeen: unknown };

interface PersistedFile {
  _v: number;
  agents: Record<string, Record<string, PersistedEntry>>;
}

function emptyFile(): PersistedFile {
  return { _v: SCHEMA_VERSION, agents: {} };
}

/** Ensure `~/.coordination/` exists (mirrors config.ts / keys.ts pattern). */
function ensureCoordDir(): void {
  if (!fs.existsSync(COORD_DIR)) {
    fs.mkdirSync(COORD_DIR, { mode: 0o700 });
  }
}

/**
 * Load the on-disk file. Missing file → empty. Unknown `_v` or malformed
 * JSON → log a warning and return empty (caller will overwrite on next
 * write). We never throw from here: the diff/cursor dedup is best-effort,
 * and a corrupt state file must not break the CLI.
 */
function loadFile(): PersistedFile {
  if (!fs.existsSync(STATE_PATH)) return emptyFile();
  let raw: string;
  try {
    raw = fs.readFileSync(STATE_PATH, 'utf-8');
  } catch (err) {
    process.stderr.write(
      `agent-persistence: could not read ${STATE_PATH} (${errMsg(err)}); resetting in memory.\n`,
    );
    return emptyFile();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(
      `agent-persistence: ${STATE_PATH} is not valid JSON (${errMsg(err)}); resetting in memory.\n`,
    );
    return emptyFile();
  }
  if (!parsed || typeof parsed !== 'object') {
    process.stderr.write(
      `agent-persistence: ${STATE_PATH} root is not an object; resetting in memory.\n`,
    );
    return emptyFile();
  }
  const obj = parsed as { _v?: unknown; agents?: unknown };
  if (obj._v !== SCHEMA_VERSION) {
    process.stderr.write(
      `agent-persistence: ${STATE_PATH} has unknown schema version (_v=${String(
        obj._v,
      )}, expected ${SCHEMA_VERSION}); resetting in memory.\n`,
    );
    return emptyFile();
  }
  const agents =
    obj.agents && typeof obj.agents === 'object' && !Array.isArray(obj.agents)
      ? (obj.agents as Record<string, Record<string, PersistedEntry>>)
      : {};
  return { _v: SCHEMA_VERSION, agents };
}

/**
 * Atomic write: serialize to `agent-state.json.tmp`, then renameSync to the
 * final path. On POSIX this is atomic so a reader never sees a half-written
 * file. Parent dir is ensured up-front.
 */
function writeFileAtomic(data: PersistedFile): void {
  ensureCoordDir();
  const body = JSON.stringify(data);
  fs.writeFileSync(TMP_PATH, body, { mode: 0o600 });
  fs.renameSync(TMP_PATH, STATE_PATH);
}

/**
 * Acquire the advisory lock via `proper-lockfile`, run the mutation, write
 * atomically, release. `proper-lockfile.lockSync` needs an existing path to
 * lock on; we lock the state file itself, creating it first if missing.
 *
 * `lockSync` doesn't support the async `retries` option, so we spin
 * briefly on contention. Cross-process contention is rare (parallel `coga
 * state` calls) and resolves within tens of ms. Same-process callers never
 * hit this because every synchronous code path releases before the next
 * microtask starts. A short busy-loop is fine for this contention profile
 * and avoids dragging in `Atomics.wait` + worker setup.
 */
const LOCK_RETRIES = 30;
const LOCK_BACKOFF_MS = 25;

function sleepSyncMs(ms: number): void {
  const end = Date.now() + ms;
  // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional spin-wait
  while (Date.now() < end) {}
}

function withLock<T>(fn: (file: PersistedFile) => { file: PersistedFile; result: T }): T {
  ensureCoordDir();
  // `proper-lockfile` requires the target file to exist. Touch it if missing.
  if (!fs.existsSync(STATE_PATH)) {
    try {
      fs.writeFileSync(STATE_PATH, JSON.stringify(emptyFile()), { mode: 0o600, flag: 'wx' });
    } catch {
      // Another process won the race and created it. That's fine — continue.
    }
  }
  let release: (() => void) | null = null;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < LOCK_RETRIES; attempt++) {
    try {
      release = lockfile.lockSync(STATE_PATH, {
        stale: 10_000,
        lockfilePath: LOCK_PATH,
      });
      break;
    } catch (err) {
      lastErr = err;
      sleepSyncMs(LOCK_BACKOFF_MS);
    }
  }
  if (!release) {
    throw new Error(
      `agent-persistence: could not acquire lock on ${STATE_PATH} after ${LOCK_RETRIES} attempts: ${errMsg(
        lastErr,
      )}`,
    );
  }
  try {
    const file = loadFile();
    const { file: next, result } = fn(file);
    writeFileAtomic(next);
    return result;
  } finally {
    try {
      release();
    } catch {
      // Best-effort release — a stale lock will be cleaned up by `stale`.
    }
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read the persisted entry for `(agent, scopeId)`, or `null` if none.
 *
 * Read path is lock-free: on POSIX, a rename-based writer gives us a
 * consistent view. The worst case from concurrent writes is that we observe
 * a slightly stale cursor, which the server's own `sinceIdx` clamp handles.
 */
export function read(agent: string, scopeId: string): PersistedEntry | null {
  const file = loadFile();
  const agentMap = file.agents[agent];
  if (!agentMap) return null;
  const entry = agentMap[scopeId];
  return entry ?? null;
}

/**
 * Write the entry for `(agent, scopeId)`. Creates the agent record and
 * scope record as needed.
 */
export function write(agent: string, scopeId: string, entry: PersistedEntry): void {
  withLock((file) => {
    const agents = { ...file.agents };
    const agentMap = { ...(agents[agent] ?? {}) };
    agentMap[scopeId] = entry;
    agents[agent] = agentMap;
    return { file: { _v: SCHEMA_VERSION, agents }, result: undefined };
  });
}

/**
 * Remove the `(agent, scopeId)` entry. Leaves other scopes on the same
 * agent untouched. No-op if there is nothing to remove.
 */
export function clear(agent: string, scopeId: string): void {
  withLock((file) => {
    const agentMap = file.agents[agent];
    if (!agentMap || !(scopeId in agentMap)) {
      return { file, result: undefined };
    }
    const nextAgentMap = { ...agentMap };
    delete nextAgentMap[scopeId];
    const agents = { ...file.agents };
    if (Object.keys(nextAgentMap).length === 0) {
      delete agents[agent];
    } else {
      agents[agent] = nextAgentMap;
    }
    return { file: { _v: SCHEMA_VERSION, agents }, result: undefined };
  });
}
