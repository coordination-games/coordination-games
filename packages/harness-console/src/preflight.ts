/**
 * Preflight self-test (docs/plans/ui-rethink.md, "reliability doctrine"): is
 * the console actually healthy right now? A demo must fail as one plain
 * sentence with an exact fix, never as a stack of dead bots — this is the
 * ONE place that logic lives. server.ts's boot log, GET /api/preflight, and
 * the demo-launch guard all call into this file; nothing re-implements a
 * check elsewhere.
 */

import { promises as fsp } from 'node:fs';
import { Socket } from 'node:net';
import path from 'node:path';
import { DEMO_GAME_SERVER } from './demos.js';
import { gameServerStatus } from './game-server.js';
import { CLI_DIST, HttpError, OUTPUT_DIR } from './paths.js';

export type CheckSeverity = 'fail' | 'warn';

export interface PreflightCheck {
  id: string;
  label: string;
  ok: boolean;
  severity: CheckSeverity;
  /** Plain sentence including the exact fix action — present when !ok. */
  detail?: string;
}

export interface PreflightReport {
  ok: boolean;
  checks: PreflightCheck[];
  nodeVersion: string;
  checkedAt: number;
}

const SPECTATOR_URL = 'http://127.0.0.1:4173';

const CLAUDE_CLI_MISSING_MESSAGE =
  'The Claude CLI is not reachable from the console (checked CLAUDE_BIN and PATH). Set ' +
  'CLAUDE_BIN to the absolute path of the claude binary in the console’s environment, then try ' +
  'again.';

function makeCheck(
  id: string,
  label: string,
  severity: CheckSeverity,
  ok: boolean,
  detail?: string,
): PreflightCheck {
  if (ok) return { id, label, ok: true, severity };
  return { id, label, ok: false, severity, detail: detail ?? `${label} check failed.` };
}

/**
 * Find the claude CLI: CLAUDE_BIN override, else scan PATH. Exported so the
 * demo-launch route uses this exact lookup — not a second copy of it.
 */
export async function findClaudeBin(): Promise<string | null> {
  const explicit = process.env.CLAUDE_BIN;
  const candidates = explicit
    ? [explicit]
    : (process.env.PATH ?? '')
        .split(':')
        .filter((dir) => dir.length > 0)
        .map((dir) => path.join(dir, 'claude'));
  for (const candidate of candidates) {
    try {
      await fsp.access(candidate);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

/** Throws the same message the preflight check would report — call this from
 * the demo-launch route instead of re-deriving the check. */
export async function assertClaudeCli(): Promise<void> {
  if (await findClaudeBin()) return;
  throw new HttpError(503, CLAUDE_CLI_MISSING_MESSAGE);
}

async function checkClaudeCli(): Promise<PreflightCheck> {
  const bin = await findClaudeBin();
  return makeCheck('claude-cli', 'Claude CLI', 'fail', bin !== null, CLAUDE_CLI_MISSING_MESSAGE);
}

async function checkCliDist(): Promise<PreflightCheck> {
  const ok = await fsp
    .access(CLI_DIST)
    .then(() => true)
    .catch(() => false);
  return makeCheck(
    'coga-cli-dist',
    'coga CLI build',
    'fail',
    ok,
    `The built coga CLI is missing at ${CLI_DIST}. Run "npm run build:cli" from the repo root, ` +
      'then re-check.',
  );
}

async function checkGameServer(): Promise<PreflightCheck> {
  const status = await gameServerStatus(DEMO_GAME_SERVER);
  return makeCheck(
    'game-server',
    'Game server',
    'warn',
    status.reachable,
    `The game server is not reachable at ${DEMO_GAME_SERVER}. Start it from Settings, or just ` +
      'launch a demo — it auto-starts on demand.',
  );
}

function tcpReachable(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket();
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
}

async function checkSpectator(): Promise<PreflightCheck> {
  const url = new URL(SPECTATOR_URL);
  const port = Number.parseInt(url.port, 10) || (url.protocol === 'https:' ? 443 : 80);
  const ok = await tcpReachable(url.hostname, port);
  return makeCheck(
    'spectator',
    'Spectator UI',
    'warn',
    ok,
    `The spectator UI is not reachable at ${SPECTATOR_URL}. Start the launchd agent ` +
      'coop.games.spectator, or run "npm run build:local && npm run preview" in packages/web.',
  );
}

async function checkRunsWritable(): Promise<PreflightCheck> {
  const probe = path.join(OUTPUT_DIR, `.preflight-${process.pid}-${Date.now()}`);
  try {
    await fsp.mkdir(OUTPUT_DIR, { recursive: true });
    await fsp.writeFile(probe, 'preflight');
    await fsp.rm(probe, { force: true });
    return makeCheck('runs-writable', 'Runs directory', 'fail', true);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return makeCheck(
      'runs-writable',
      'Runs directory',
      'fail',
      false,
      `Cannot write to the runs output directory at ${OUTPUT_DIR} (${reason}). Check ` +
        'permissions on that directory.',
    );
  }
}

export async function runPreflight(): Promise<PreflightReport> {
  const checks = await Promise.all([
    checkClaudeCli(),
    checkCliDist(),
    checkGameServer(),
    checkSpectator(),
    checkRunsWritable(),
  ]);
  return {
    ok: checks.every((c) => c.ok || c.severity !== 'fail'),
    checks,
    nodeVersion: process.version,
    checkedAt: Date.now(),
  };
}
