/**
 * Run manager — drives the EXISTING harness CLI (`tsx src/index.ts run …`) as a
 * child process. No orchestration is reimplemented here: dry-runs and live
 * runs both go through the same `src/index.ts` entry the terminal uses.
 *
 * Safety bounds: no shell, fixed binary + fixed arg shape, cwd pinned to the
 * workspace root, capped log retention, capped concurrent children, hard
 * child-lifetime ceiling, SIGTERM→SIGKILL stop escalation.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { PACKAGE_ROOT, REPO_ROOT } from './paths.js';
import { redactText } from './redact.js';

export type RunKind = 'run' | 'dry-run';
export type GuiRunStatus = 'running' | 'completed' | 'failed' | 'stopped';

export interface LogEntry {
  stream: 'stdout' | 'stderr' | 'system';
  text: string;
  ts: string;
}

export interface PublicRun {
  id: string;
  kind: RunKind;
  specId: string;
  specName: string;
  status: GuiRunStatus;
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
  logCount: number;
}

export type RunListener = (event: 'log' | 'status', payload: unknown) => void;

interface RunRecord {
  pub: PublicRun;
  logs: LogEntry[];
  listeners: Set<RunListener>;
  child: ChildProcess | null;
  stopRequested: boolean;
  timers: ReturnType<typeof setTimeout>[];
}

// ── Bounds ──────────────────────────────────────────────────────────────────
const MAX_LOG_ENTRIES = 1_000;
const MAX_LOG_TEXT = 8_192;
const MAX_ACTIVE_CHILDREN = 2;
const MAX_RETAINED_RUNS = 20;
const STOP_GRACE_MS = 5_000;
/** Hard ceiling on any child's lifetime (the spec's own wall-clock limit is
 * expected to fire first; this is the GUI's backstop). */
const CHILD_LIFETIME_MS = 2 * 60 * 60 * 1_000;

const TSX_BIN = path.join(
  REPO_ROOT,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'tsx.cmd' : 'tsx',
);
const INDEX_TS = path.join(PACKAGE_ROOT, 'src', 'index.ts');

/** Exact argv for the harness CLI. Exported pure for tests. */
export function buildHarnessArgs(specAbs: string, kind: RunKind): string[] {
  return kind === 'dry-run' ? [INDEX_TS, 'run', '--dry-run', specAbs] : [INDEX_TS, 'run', specAbs];
}

/** Terminal status from how the child ended. Exported pure for tests. */
export function finalStatus(stopRequested: boolean, exitCode: number | null): GuiRunStatus {
  if (stopRequested) return 'stopped';
  return exitCode === 0 ? 'completed' : 'failed';
}

export class RunManager {
  private readonly runs = new Map<string, RunRecord>();

  /** Spawn a harness run. Throws if concurrency bounds are hit. */
  start(spec: { id: string; name: string; abs: string }, kind: RunKind): PublicRun {
    const active = [...this.runs.values()].filter((r) => r.pub.status === 'running');
    if (active.length >= MAX_ACTIVE_CHILDREN) {
      throw new Error(`at most ${MAX_ACTIVE_CHILDREN} harness processes may run at once`);
    }
    if (kind === 'run' && active.some((r) => r.pub.kind === 'run')) {
      throw new Error('a live run is already in progress — stop it first');
    }

    const id = randomUUID();
    const record: RunRecord = {
      pub: {
        id,
        kind,
        specId: spec.id,
        specName: spec.name,
        status: 'running',
        startedAt: new Date().toISOString(),
        endedAt: null,
        exitCode: null,
        logCount: 0,
      },
      logs: [],
      listeners: new Set(),
      child: null,
      stopRequested: false,
      timers: [],
    };
    this.runs.set(id, record);
    this.evictOldest();

    const args = buildHarnessArgs(spec.abs, kind);
    const child = spawn(TSX_BIN, args, {
      cwd: REPO_ROOT,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    record.child = child;
    this.log(record, 'system', `spawned harness (${kind}) for ${spec.name}`);

    child.stdout?.on('data', (chunk: Buffer) => this.log(record, 'stdout', chunk.toString('utf8')));
    child.stderr?.on('data', (chunk: Buffer) => this.log(record, 'stderr', chunk.toString('utf8')));
    child.on('error', (err) => {
      this.log(record, 'system', `spawn error: ${err.message}`);
      this.finish(record, null);
    });
    child.on('exit', (code) => this.finish(record, code));

    const lifetime = setTimeout(() => {
      this.log(record, 'system', 'child exceeded the GUI lifetime ceiling — killing');
      record.stopRequested = true;
      child.kill('SIGKILL');
    }, CHILD_LIFETIME_MS);
    lifetime.unref();
    record.timers.push(lifetime);

    return { ...record.pub };
  }

  /** Request a stop: SIGTERM now, SIGKILL after the grace window. */
  stop(id: string): PublicRun {
    const record = this.mustGet(id);
    if (record.pub.status !== 'running' || !record.child) return { ...record.pub };
    record.stopRequested = true;
    this.log(record, 'system', 'stop requested (SIGTERM)');
    record.child.kill('SIGTERM');
    const killer = setTimeout(() => {
      if (record.pub.status === 'running') {
        this.log(record, 'system', 'grace window elapsed — SIGKILL');
        record.child?.kill('SIGKILL');
      }
    }, STOP_GRACE_MS);
    killer.unref();
    record.timers.push(killer);
    return { ...record.pub };
  }

  list(): PublicRun[] {
    return [...this.runs.values()].map((r) => ({ ...r.pub })).reverse();
  }

  get(id: string): PublicRun {
    return { ...this.mustGet(id).pub };
  }

  logsOf(id: string): LogEntry[] {
    return [...this.mustGet(id).logs];
  }

  subscribe(id: string, listener: RunListener): () => void {
    const record = this.mustGet(id);
    record.listeners.add(listener);
    return () => record.listeners.delete(listener);
  }

  /** Kill every live child (server shutdown). */
  killAll(): void {
    for (const record of this.runs.values()) {
      if (record.pub.status === 'running' && record.child) {
        record.stopRequested = true;
        record.child.kill('SIGKILL');
      }
      for (const t of record.timers) clearTimeout(t);
    }
  }

  private mustGet(id: string): RunRecord {
    const record = this.runs.get(id);
    if (!record) throw new Error('no such run');
    return record;
  }

  private finish(record: RunRecord, exitCode: number | null): void {
    if (record.pub.status !== 'running') return;
    record.pub.status = finalStatus(record.stopRequested, exitCode);
    record.pub.exitCode = exitCode;
    record.pub.endedAt = new Date().toISOString();
    for (const t of record.timers) clearTimeout(t);
    this.log(
      record,
      'system',
      `harness exited (code=${exitCode ?? 'signal'}) → ${record.pub.status}`,
    );
    this.emit(record, 'status', { ...record.pub });
  }

  private log(record: RunRecord, stream: LogEntry['stream'], raw: string): void {
    const entry: LogEntry = {
      stream,
      text: redactText(raw).slice(0, MAX_LOG_TEXT),
      ts: new Date().toISOString(),
    };
    record.logs.push(entry);
    if (record.logs.length > MAX_LOG_ENTRIES) record.logs.shift();
    record.pub.logCount = record.logs.length;
    this.emit(record, 'log', entry);
  }

  private emit(record: RunRecord, event: 'log' | 'status', payload: unknown): void {
    for (const listener of record.listeners) listener(event, payload);
  }

  /** Drop the oldest finished records past the retention cap. */
  private evictOldest(): void {
    const finished = [...this.runs.entries()].filter(([, r]) => r.pub.status !== 'running');
    let excess = this.runs.size - MAX_RETAINED_RUNS;
    for (const [id] of finished) {
      if (excess <= 0) break;
      this.runs.delete(id);
      excess--;
    }
  }
}
