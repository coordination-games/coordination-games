/**
 * Cross-process boot lock — a machine-wide mutex serializing `claude` session
 * boots across ALL harness processes, not just seats within one.
 *
 * Companion to the in-process FIFO lock in claude.ts (see the comment there
 * for why boots must serialize at all: concurrent boots race their MCP
 * server's startup against the session's tool-list snapshot). That FIFO only
 * orders seats inside a single orchestrate() Promise.all — it does nothing
 * when two separate harness processes (e.g. a demo and a study) boot seats
 * at the same time, which reproduces the same race one level up. This module
 * closes that gap with an OS-level mutex any process can join.
 *
 * Design: a lock DIRECTORY at os.tmpdir()/coga-boot-lock. `mkdir` without
 * `recursive` is atomic — exactly one concurrent caller's mkdir succeeds,
 * everyone else gets EEXIST — so the directory's existence IS the lock, no
 * separate lockfile library needed. A meta.json written just after acquiring
 * records {pid, acquiredAt}, which lets a later caller detect and steal a
 * lock abandoned by a crashed process (dead pid, or held past STALE_MS)
 * instead of wedging every future boot on the machine forever.
 *
 * Exported standalone (not folded into claude.ts) so it's unit-testable by
 * spawning independent node processes against it directly.
 */

import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const BOOT_LOCK_DIR = path.join(os.tmpdir(), 'coga-boot-lock');
const META_FILE = path.join(BOOT_LOCK_DIR, 'meta.json');

const POLL_MS = 250;
const STALE_MS = 120_000;

interface LockMeta {
  pid: number;
  acquiredAt: number;
}

function isAlive(pid: number): boolean {
  try {
    // Signal 0: no-op existence probe — throws ESRCH if the pid is gone.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readMeta(): Promise<LockMeta | undefined> {
  try {
    const raw = await fsp.readFile(META_FILE, 'utf8');
    const parsed = JSON.parse(raw) as Partial<LockMeta>;
    if (typeof parsed.pid === 'number' && typeof parsed.acquiredAt === 'number') {
      return { pid: parsed.pid, acquiredAt: parsed.acquiredAt };
    }
  } catch {
    // Missing or corrupt meta — the caller treats this as untrustworthy,
    // which is the safe (stealable) direction: an unreadable meta can only
    // mean a holder that crashed between mkdir and the meta write.
  }
  return undefined;
}

/** True when the current lock holder is gone (dead pid) or has held the
 * lock past STALE_MS — either way, the lock is abandoned, not contended. */
async function isStale(): Promise<boolean> {
  const meta = await readMeta();
  if (!meta) return true;
  if (!isAlive(meta.pid)) return true;
  if (Date.now() - meta.acquiredAt > STALE_MS) return true;
  return false;
}

/** Remove an abandoned lock dir so the next mkdir attempt can take it over.
 * No-op (silently) if the lock is still legitimately held. */
async function stealIfStale(): Promise<void> {
  if (!(await isStale())) return;
  console.error(`[boot-lock] stale lock at ${BOOT_LOCK_DIR} — taking over`);
  await fsp.rm(BOOT_LOCK_DIR, { recursive: true, force: true });
}

/**
 * Acquire the machine-wide boot mutex. Resolves once this process holds the
 * lock; polls every 250ms while contended, stealing stale locks along the
 * way. Returns a release function — call it exactly once (idempotent
 * best-effort rm; never throws) to free the lock for the next waiter.
 */
export async function acquireCrossProcessBootLock(): Promise<() => Promise<void>> {
  for (;;) {
    try {
      await fsp.mkdir(BOOT_LOCK_DIR);
      const meta: LockMeta = { pid: process.pid, acquiredAt: Date.now() };
      await fsp.writeFile(META_FILE, JSON.stringify(meta));
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      await stealIfStale();
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  }

  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try {
      await fsp.rm(BOOT_LOCK_DIR, { recursive: true, force: true });
    } catch {
      // Best-effort — a release must never throw into a caller's exit path.
    }
  };
}
