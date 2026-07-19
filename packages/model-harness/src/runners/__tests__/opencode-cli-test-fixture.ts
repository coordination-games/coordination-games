import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { RunSessionOptions, TranscriptEvent } from '../../types.js';

const fakeSource = `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const args = process.argv.slice(2);
const recordPath = process.env.HARNESS_OPENCODE_RECORD;
const mode = process.env.HARNESS_OPENCODE_MODE ?? 'finished';
const append = (value) => appendFileSync(recordPath, JSON.stringify(value) + '\\n');
if (args[0] === 'session' && args[1] === 'delete') {
  append({ kind: 'cleanup', args });
  process.exit(0);
}
const sessionIndex = args.indexOf('--session');
const sessionID = sessionIndex >= 0 ? args[sessionIndex + 1] : 'ses_fake_opencode';
const runtimeIndex = args.indexOf('--dir');
const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);
append({
  kind: 'run',
  args,
  cwd: process.cwd(),
  runtimeDirectory: args[runtimeIndex + 1],
  config,
  outputTokenCap: process.env.OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX,
});
const emit = (type, part) => console.log(JSON.stringify({ type, timestamp: Date.now(), sessionID, part }));
const start = () => emit('step_start', { id: 'start', sessionID, messageID: 'message', type: 'step-start' });
const tool = (name, input, output) => emit('tool_use', {
  id: 'tool', sessionID, messageID: 'message', type: 'tool', callID: 'call', tool: name,
  state: { status: 'completed', input, output: JSON.stringify(output), title: name, metadata: {}, time: { start: 1, end: 2 } },
});
const finish = (reason = 'stop') => emit('step_finish', {
  id: 'finish', sessionID, messageID: 'message', type: 'step-finish', reason, cost: 0,
  tokens: { input: 3, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
});
if (mode === 'communication-correction') {
  const prompt = args.at(-1);
  start();
  if (sessionIndex < 0) {
    tool('coga_state', {}, { result: { state: { you: { id: 'player-self' }, scoreboard: [{ id: 'player-self' }, { id: 'player-target' }] } } });
    finish('tool-calls');
  } else if (prompt.includes('"publicChatSucceeded":false')) {
    tool('coga_chat', { message: 'public coordination', scope: 'all' }, { ok: true });
    finish('tool-calls');
  } else if (prompt.includes('"directChatSucceeded":false')) {
    tool('coga_chat', { message: 'direct coordination', scope: 'player-target' }, { ok: true });
    finish('stop');
  } else {
    tool('coga_state', {}, { phase: 'finished' });
    finish('stop');
  }
} else if (mode === 'remaining-steps') {
  const count = sessionIndex < 0 ? 2 : config.agent['coga-game'].steps;
  for (let index = 0; index < count; index++) {
    start();
    finish(index + 1 === count ? 'stop' : 'tool-calls');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
} else if (mode === 'hang') {
  const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setTimeout(() => process.exit(97), 4000); setInterval(() => {}, 1000)', recordPath], { stdio: 'ignore' });
  append({ kind: 'descendant', pid: child.pid, parentPid: process.pid, processGroupId: process.pid, cwd: process.cwd(), marker: recordPath });
  start();
  setTimeout(() => process.exit(97), 4000);
  setInterval(() => {}, 1000);
} else {
  start();
  if (mode === 'resume' && sessionIndex < 0) {
    emit('text', { id: 'text', sessionID, messageID: 'message', type: 'text', text: 'continue', time: { start: 1, end: 2 } });
    finish('stop');
  } else if (mode === 'unfinished') {
    finish('stop');
  } else {
    emit('tool_use', {
      id: 'tool', sessionID, messageID: 'message', type: 'tool', callID: 'call', tool: 'coga_state',
      state: { status: 'completed', input: {}, output: '{"phase":"finished"}', title: 'state', metadata: {}, time: { start: 1, end: 2 } },
    });
    emit('text', { id: 'text', sessionID, messageID: 'message', type: 'text', text: 'Game finished.', time: { start: 1, end: 2 } });
    finish('stop');
  }
}
`;

export type FakeContext = {
  readonly directory: string;
  readonly recordPath: string;
};

export function options(
  events: TranscriptEvent[],
  patch: Partial<RunSessionOptions> = {},
): RunSessionOptions {
  return {
    botName: 'bot-opencode',
    privateKey: 'ephemeral-seat-key',
    server: 'http://127.0.0.1:8787',
    systemPrompt: 'test game persona',
    model: 'minimax-coding-plan/MiniMax-M3',
    modelConfig: {
      provider: 'opencode-cli',
      model: 'minimax-coding-plan/MiniMax-M3',
      maxCompletionTokens: 10,
      reasoningEffort: 'none',
    },
    limits: { maxModelCalls: 3, wallClockMs: 5_000 },
    onEvent: (event) => events.push(event),
    ...patch,
  };
}

export async function withFakeOpenCode(
  mode: string,
  assertion: (context: FakeContext) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), 'opencode-runner-test-'));
  const binary = path.join(directory, 'fake-opencode.mjs');
  const recordPath = path.join(directory, 'records.jsonl');
  const before = {
    binary: process.env.OPENCODE_BIN,
    mode: process.env.HARNESS_OPENCODE_MODE,
    record: process.env.HARNESS_OPENCODE_RECORD,
  };
  await writeFile(binary, fakeSource);
  await chmod(binary, 0o700);
  process.env.OPENCODE_BIN = binary;
  process.env.HARNESS_OPENCODE_MODE = mode;
  process.env.HARNESS_OPENCODE_RECORD = recordPath;
  try {
    await assertion({ directory, recordPath });
  } finally {
    restoreEnvironment('OPENCODE_BIN', before.binary);
    restoreEnvironment('HARNESS_OPENCODE_MODE', before.mode);
    restoreEnvironment('HARNESS_OPENCODE_RECORD', before.record);
    await stopRecordedDescendants(recordPath);
    await rm(directory, { recursive: true, force: true });
  }
}

export async function recordsFrom(recordPath: string): Promise<unknown[]> {
  const content = await readFile(recordPath, 'utf8');
  return content
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((entry): unknown => JSON.parse(entry));
}

export function isRunRecord(value: unknown): boolean {
  return isRecord(value) && value.kind === 'run';
}

export function isDescendantRecord(value: unknown): value is {
  readonly kind: 'descendant';
  readonly pid: number;
  readonly parentPid: number;
  readonly processGroupId: number;
  readonly cwd: string;
  readonly marker: string;
} {
  return (
    isRecord(value) &&
    value.kind === 'descendant' &&
    typeof value.pid === 'number' &&
    typeof value.parentPid === 'number' &&
    typeof value.processGroupId === 'number' &&
    typeof value.cwd === 'string' &&
    typeof value.marker === 'string'
  );
}

export function runtimeDirectoryFrom(value: unknown): string {
  if (isRecord(value) && typeof value.runtimeDirectory === 'string') return value.runtimeDirectory;
  throw new Error('fake OpenCode record omitted runtimeDirectory');
}

export function argsFrom(value: unknown): readonly unknown[] {
  if (isRecord(value) && Array.isArray(value.args)) return value.args;
  throw new Error('fake OpenCode record omitted args');
}

export function stepsFrom(value: unknown): number {
  if (!isRecord(value)) throw new Error('fake OpenCode record must be an object');
  const config = isRecord(value.config) ? value.config : undefined;
  const agent = isRecord(config?.agent) ? config.agent : undefined;
  const gameAgent = isRecord(agent?.['coga-game']) ? agent['coga-game'] : undefined;
  if (typeof gameAgent?.steps === 'number') return gameAgent.steps;
  throw new Error('fake OpenCode record omitted agent steps');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function restoreEnvironment(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

async function stopRecordedDescendants(recordPath: string): Promise<void> {
  let records: readonly unknown[];
  try {
    records = await recordsFrom(recordPath);
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return;
    throw error;
  }
  for (const record of records.filter(isDescendantRecord)) {
    if (record.marker !== recordPath || !isProcessAlive(record.pid)) continue;
    try {
      process.kill(record.pid, 'SIGKILL');
    } catch (error) {
      if (!hasCode(error, 'ESRCH')) throw error;
    }
    for (let attempt = 0; attempt < 40 && isProcessAlive(record.pid); attempt++) {
      await delay(25);
    }
  }
}

function isProcessAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    if (hasCode(error, 'ESRCH')) return false;
    throw error;
  }
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}
