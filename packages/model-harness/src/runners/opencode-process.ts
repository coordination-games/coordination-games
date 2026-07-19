import { spawn } from 'node:child_process';

export type OpenCodeProcessResult = {
  readonly exitCode: number | null;
  readonly cancelled: boolean;
  readonly stopped: boolean;
  readonly timedOut: boolean;
};

export class OpenCodeProcessError extends Error {
  readonly name = 'OpenCodeProcessError';

  constructor(
    readonly reason: string,
    options?: ErrorOptions,
  ) {
    super(`OpenCode process failed: ${reason}`, options);
  }
}

export function runOpenCodeProcess(input: {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly onLine: (line: string) => boolean;
}): Promise<OpenCodeProcessResult> {
  if (input.signal?.aborted) {
    return Promise.resolve({ exitCode: null, cancelled: true, stopped: false, timedOut: false });
  }
  return new Promise((resolve, reject) => {
    const child = spawn(input.command, [...input.args], {
      cwd: input.cwd,
      detached: process.platform !== 'win32',
      env: input.environment,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const processId = child.pid;
    if (!processId) {
      reject(new OpenCodeProcessError('child process did not provide a process id'));
      return;
    }
    let stdout = '';
    let cancelled = false;
    let stopped = false;
    let timedOut = false;
    let exited = false;
    let termination: Promise<void> | undefined;
    let settled = false;

    const terminate = (): Promise<void> => {
      termination ??= stopProcessTree(processId, () => exited, child.kill.bind(child));
      return termination;
    };
    const abort = (): void => {
      cancelled = true;
      void terminate().catch(() => undefined);
    };
    input.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      void terminate().catch(() => undefined);
    }, input.timeoutMs);
    timer.unref();

    const consume = (final: boolean): void => {
      const lines = stdout.split('\n');
      stdout = final ? '' : (lines.pop() ?? '');
      for (const line of lines) {
        if (!line.trim()) continue;
        if (input.onLine(line)) {
          stopped = true;
          void terminate().catch(() => undefined);
        }
      }
    };
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      consume(false);
    });
    child.stderr?.resume();
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', abort);
      reject(new OpenCodeProcessError('spawn error', { cause: error }));
    });
    child.once('close', (exitCode) => {
      exited = true;
      consume(true);
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', abort);
      void (termination ?? terminate()).then(
        () => {
          if (settled) return;
          settled = true;
          resolve({ exitCode, cancelled, stopped, timedOut });
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          reject(new OpenCodeProcessError('process cleanup failed', { cause: error }));
        },
      );
    });
  });
}

export async function deleteOpenCodeSession(input: {
  readonly command: string;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly sessionId: string;
}): Promise<void> {
  const result = await runOpenCodeProcess({
    command: input.command,
    args: ['session', 'delete', input.sessionId, '--pure'],
    cwd: input.cwd,
    environment: input.environment,
    timeoutMs: 5_000,
    onLine: () => false,
  });
  if (result.exitCode !== 0) throw new OpenCodeProcessError('session cleanup command failed');
}

type Kill = (signal?: NodeJS.Signals | number) => boolean;

function stopProcessTree(processId: number, exited: () => boolean, killChild: Kill): Promise<void> {
  if (process.platform === 'win32') {
    killChild('SIGKILL');
    return Promise.resolve();
  }
  const groupId = -processId;
  try {
    process.kill(groupId, 'SIGTERM');
  } catch (error) {
    if (!(error instanceof Error)) return Promise.reject(error);
    if (hasCode(error, 'ESRCH')) return Promise.resolve();
    return Promise.reject(error);
  }
  return new Promise((resolve, reject) => {
    let forced = false;
    const deadline = Date.now() + 2_000;
    const probe = (): void => {
      try {
        process.kill(groupId, 0);
      } catch (error) {
        if (!(error instanceof Error)) {
          reject(error);
          return;
        }
        if (hasCode(error, 'ESRCH') || (hasCode(error, 'EPERM') && exited())) {
          resolve();
          return;
        }
        if (!hasCode(error, 'EPERM')) {
          reject(error);
          return;
        }
      }
      if (!forced && Date.now() >= deadline - 1_000) {
        forced = true;
        try {
          process.kill(groupId, 'SIGKILL');
        } catch (error) {
          if (!(error instanceof Error)) {
            reject(error);
            return;
          }
          if (hasCode(error, 'ESRCH')) {
            resolve();
            return;
          }
          reject(error);
          return;
        }
      }
      if (Date.now() >= deadline) {
        reject(new OpenCodeProcessError(`process group ${groupId} survived SIGKILL`));
        return;
      }
      setTimeout(probe, 25);
    };
    probe();
  });
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}
