/**
 * Job runner: spawn `coga-harness run <spec.yaml>` (and `analyze`) as child
 * processes, buffer + broadcast redacted output over SSE.
 *
 * The One Rule applied to the console: this file contains NO orchestration
 * logic — it shells out to the exact CLI a human would run. Job records are
 * in-memory (they describe live processes); run HISTORY comes from disk via
 * artifacts.ts, so a console restart loses nothing durable.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import type { ServerResponse } from 'node:http';
import path from 'node:path';
import { stringify as yamlStringify } from 'yaml';
import {
  CLI_DIST,
  CLI_ENTRY,
  HARNESS_ENTRY,
  HttpError,
  REPO_ROOT,
  SPECS_DIR,
  TSX_BIN,
} from './paths.js';
import { redact } from './redact.js';
import { childEnv } from './secrets.js';

export type JobKind = 'campaign' | 'analyze';
export type JobStatus = 'running' | 'done' | 'error' | 'stopped';

export interface JobPublic {
  id: string;
  kind: JobKind;
  status: JobStatus;
  startedAt: number;
  endedAt?: number;
  specPath?: string;
  /** Discovered from harness stdout ("[campaign] campaign-<ts> — N runs → dir"). */
  campaignId?: string;
  exitCode?: number | null;
}

interface JobRecord {
  pub: JobPublic;
  child: ChildProcess;
  logs: string[];
  clients: Set<ServerResponse>;
}

const MAX_LOG_LINES = 4000;
const MAX_FINISHED_JOBS = 50;

const jobs = new Map<string, JobRecord>();
let jobCounter = 0;

function nextJobId(kind: JobKind): string {
  jobCounter += 1;
  return `${kind}-${Date.now()}-${jobCounter}`;
}

function sseSend(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcast(job: JobRecord, event: string, data: unknown): void {
  for (const client of job.clients) {
    try {
      sseSend(client, event, data);
    } catch {
      job.clients.delete(client);
    }
  }
}

function appendLog(job: JobRecord, line: string): void {
  const safe = redact(line);
  job.logs.push(safe);
  if (job.logs.length > MAX_LOG_LINES) job.logs.splice(0, job.logs.length - MAX_LOG_LINES);
  // Discover the campaign dir so the UI can link job → results as soon as it exists.
  if (!job.pub.campaignId) {
    const m = /\[campaign\] (campaign-\d+) — \d+ runs/.exec(safe);
    if (m?.[1]) {
      job.pub.campaignId = m[1];
      broadcast(job, 'status', job.pub);
    }
  }
  broadcast(job, 'log', { line: safe });
}

function wireChild(job: JobRecord): void {
  const onChunk = (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n')) {
      if (line.trim().length > 0) appendLog(job, line);
    }
  };
  job.child.stdout?.on('data', onChunk);
  job.child.stderr?.on('data', onChunk);
  job.child.on('exit', (code) => {
    job.pub.endedAt = Date.now();
    job.pub.exitCode = code;
    if (job.pub.status === 'running') job.pub.status = code === 0 ? 'done' : 'error';
    broadcast(job, 'status', job.pub);
    for (const client of job.clients) client.end();
    job.clients.clear();
    pruneFinished();
  });
}

function pruneFinished(): void {
  const finished = [...jobs.values()]
    .filter((j) => j.pub.status !== 'running')
    .sort((a, b) => (a.pub.endedAt ?? 0) - (b.pub.endedAt ?? 0));
  while (finished.length > MAX_FINISHED_JOBS) {
    const oldest = finished.shift();
    if (oldest) jobs.delete(oldest.pub.id);
  }
}

/**
 * Strip Claude Code session vars from a child env. When the console itself is
 * launched from inside a Claude Code session (agent-driven ops), these leak
 * into spawned `claude --print` bots, which then RACILY bind to the parent
 * session's tool surface instead of their own --mcp-config — the bot sees
 * TaskCreate/Workflow/etc. and zero coga tools, and burns its session
 * (observed live, 2026-07-03: sonnet-5 seats dead at modelCalls=1 while
 * haiku seats attached fine).
 */
function withoutClaudeSessionVars(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_') || k === 'CLAUDE_EFFORT') continue;
    clean[k] = v;
  }
  return clean;
}

async function spawnHarness(kind: JobKind, args: string[]): Promise<JobRecord> {
  const env = { ...withoutClaudeSessionVars(process.env), ...(await childEnv()) };
  // Bots ride the repo's coga CLI, not npm's `coordination-games@latest` — the
  // published-package default cold-downloads via npx and can miss the MCP
  // startup window (observed: bots come up with zero coga tools). Prefer the
  // built CLI: N concurrent tsx compiles are slow enough to lose the same race
  // (seats stuck at MCP "pending"). Honors a caller-set COGA_SERVE_CMD.
  // (cogaServeCommand splits on whitespace → relies on a space-free repo path.)
  if (!env.COGA_SERVE_CMD) {
    const hasDist = await fsp
      .access(CLI_DIST)
      .then(() => true)
      .catch(() => false);
    env.COGA_SERVE_CMD = hasDist ? `node ${CLI_DIST}` : `${TSX_BIN} ${CLI_ENTRY}`;
    if (!hasDist) {
      console.warn('[console] packages/cli/dist missing — run `npm run build:cli`; using tsx');
    }
  }
  const child = spawn(TSX_BIN, [HARNESS_ENTRY, ...args], {
    cwd: REPO_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const job: JobRecord = {
    pub: { id: nextJobId(kind), kind, status: 'running', startedAt: Date.now() },
    child,
    logs: [],
    clients: new Set(),
  };
  jobs.set(job.pub.id, job);
  wireChild(job);
  return job;
}

/** Write the campaign spec YAML and launch `coga-harness run`. */
export async function startCampaign(spec: Record<string, unknown>): Promise<JobPublic> {
  await fsp.mkdir(SPECS_DIR, { recursive: true });
  const specPath = path.join(SPECS_DIR, `spec-${Date.now()}.yaml`);
  await fsp.writeFile(specPath, yamlStringify(spec));
  const job = await spawnHarness('campaign', ['run', specPath]);
  job.pub.specPath = path.relative(REPO_ROOT, specPath);
  appendLog(job, `[console] launched coga-harness run ${job.pub.specPath}`);
  return job.pub;
}

/** Launch `coga-harness analyze <runDir>` (re-judge an existing run). */
export async function startAnalyze(runDir: string, model?: string): Promise<JobPublic> {
  const args = ['analyze', runDir];
  if (model) args.push('--model', model);
  const job = await spawnHarness('analyze', args);
  appendLog(job, `[console] launched coga-harness ${args.join(' ')}`);
  return job.pub;
}

export function listJobs(): JobPublic[] {
  return [...jobs.values()].map((j) => j.pub).sort((a, b) => b.startedAt - a.startedAt);
}

/** Campaign dirs with a live harness process — lets the read layer mark their
 * manifest-less runs 'running' rather than 'incomplete'. */
export function activeCampaignIds(): Set<string> {
  const ids = new Set<string>();
  for (const j of jobs.values()) {
    if (j.pub.status === 'running' && j.pub.campaignId) ids.add(j.pub.campaignId);
  }
  return ids;
}

function getJob(id: string): JobRecord {
  const job = jobs.get(id);
  if (!job) throw new HttpError(404, `job not found: ${id}`);
  return job;
}

export function stopJob(id: string): JobPublic {
  const job = getJob(id);
  if (job.pub.status === 'running') {
    job.pub.status = 'stopped';
    job.child.kill('SIGTERM');
    appendLog(job, '[console] SIGTERM sent');
    broadcast(job, 'status', job.pub);
  }
  return job.pub;
}

/** Attach an SSE client: replay the buffered log, then stream. */
export function attachJobEvents(id: string, res: ServerResponse): void {
  const job = getJob(id);
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  sseSend(res, 'status', job.pub);
  for (const line of job.logs) sseSend(res, 'log', { line });
  if (job.pub.status !== 'running') {
    res.end();
    return;
  }
  job.clients.add(res);
  res.on('close', () => job.clients.delete(res));
}
