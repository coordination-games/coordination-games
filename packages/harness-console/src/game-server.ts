/**
 * Local game-server lifecycle (Djimo's "runtime" panel, in-repo edition):
 * status-check the workers-server, start it (`npm run dev` in
 * packages/workers-server), stream its logs, stop it. Loopback targets only.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import path from 'node:path';
import { HttpError, REPO_ROOT } from './paths.js';
import { redact } from './redact.js';

const WORKERS_DIR = path.join(REPO_ROOT, 'packages', 'workers-server');
const MAX_LOG_LINES = 500;

interface GameServerState {
  child: ChildProcess | null;
  logs: string[];
  /** URL parsed from wrangler's "Ready on http://..." line. */
  readyUrl: string | null;
}

const state: GameServerState = { child: null, logs: [], readyUrl: null };

function appendLog(line: string): void {
  state.logs.push(redact(line));
  if (state.logs.length > MAX_LOG_LINES) state.logs.splice(0, state.logs.length - MAX_LOG_LINES);
  const ready = /Ready on (https?:\/\/[^\s]+)/.exec(line);
  if (ready?.[1]) state.readyUrl = ready[1].replace(/\/+$/, '');
}

function assertLoopback(target: string): URL {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    throw new HttpError(400, `invalid server url: ${target}`);
  }
  const host = url.hostname;
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) {
    throw new HttpError(400, 'game-server checks are restricted to loopback targets');
  }
  return url;
}

export interface GameServerStatus {
  reachable: boolean;
  target: string;
  managed: boolean;
  readyUrl: string | null;
  logs: string[];
}

export async function gameServerStatus(target: string): Promise<GameServerStatus> {
  const url = assertLoopback(target);
  let reachable = false;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    const res = await fetch(new URL('/api/games', url), { signal: controller.signal });
    clearTimeout(timer);
    reachable = res.ok;
  } catch {
    reachable = false;
  }
  return {
    reachable,
    target: url.origin,
    managed: state.child !== null && state.child.exitCode === null,
    readyUrl: state.readyUrl,
    logs: state.logs.slice(-80),
  };
}

export function startGameServer(): { started: boolean } {
  if (state.child && state.child.exitCode === null) return { started: false };
  state.logs = [];
  state.readyUrl = null;
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const child = spawn(npmCmd, ['run', 'dev'], {
    cwd: WORKERS_DIR,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const onChunk = (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n')) {
      if (line.trim().length > 0) appendLog(line);
    }
  };
  child.stdout?.on('data', onChunk);
  child.stderr?.on('data', onChunk);
  child.on('exit', (code) => {
    appendLog(`[console] game server exited (code ${code})`);
    state.child = null;
  });
  state.child = child;
  appendLog('[console] starting game server: npm run dev (packages/workers-server)');
  return { started: true };
}

export function stopGameServer(): { stopped: boolean } {
  if (!state.child || state.child.exitCode !== null) return { stopped: false };
  state.child.kill('SIGTERM');
  appendLog('[console] SIGTERM sent to game server');
  return { stopped: true };
}
