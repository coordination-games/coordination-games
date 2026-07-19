import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { LOCAL_TREASURY_HANDLE, writeRuntimeConfig } from './local-bootstrap-config.js';
import {
  BootstrapInputError,
  buildWranglerCommands,
  type LocalBootstrapOptions,
  persistenceIsInside,
} from './local-bootstrap-options.js';

const strippedEnvironmentKeys = [
  'RPC_URL',
  'RPC_URLS',
  'RELAYER_PRIVATE_KEY',
  'REGISTRY_ADDRESS',
  'ERC8004_ADDRESS',
  'CREDITS_ADDRESS',
  'GAME_ANCHOR_ADDRESS',
  'USDC_ADDRESS',
] as const;

const LOCAL_TREASURY_ID = 'local-tournament-treasury';
const LOCAL_TREASURY_CHAIN_AGENT_ID = 2_147_483_647;
const LOCAL_TREASURY_WALLET = '0x0000000000000000000000000000000000000001';

export type LocalBootstrap = {
  readonly port: number;
  readonly processId: number;
  readonly migrationOutput: string;
  readonly stop: () => Promise<void>;
};

function environment(): NodeJS.ProcessEnv {
  const values = { ...process.env };
  for (const key of strippedEnvironmentKeys) delete values[key];
  return values;
}

function command(
  executable: string,
  argumentsList: readonly string[],
  cwd: string,
): Promise<string> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(executable, argumentsList, {
      cwd,
      env: environment(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0
        ? resolveResult(output)
        : reject(new Error(`Wrangler exited with code ${code ?? 'unknown'}: ${output}`)),
    );
  });
}

type ProcessKiller = (processId: number, signal: NodeJS.Signals | 0) => boolean;

export function isErrnoExceptionWithCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

export function stopProcessGroup(
  processId: number,
  kill: ProcessKiller = process.kill,
  childExited: () => boolean = () => false,
): Promise<void> {
  const groupId = -processId;
  try {
    kill(groupId, 'SIGTERM');
  } catch (error) {
    if (isErrnoExceptionWithCode(error, 'ESRCH')) return Promise.resolve();
    return Promise.reject(error);
  }
  return new Promise((resolveStop, rejectStop) => {
    let graceTimer: NodeJS.Timeout | undefined;
    let forcedVerificationTimer: NodeJS.Timeout | undefined;
    let interval: NodeJS.Timeout | undefined;
    let finished = false;
    const finish = (error?: unknown): void => {
      if (finished) return;
      finished = true;
      if (graceTimer) clearTimeout(graceTimer);
      if (forcedVerificationTimer) clearTimeout(forcedVerificationTimer);
      if (interval) clearInterval(interval);
      if (error) rejectStop(error);
      else resolveStop();
    };
    const probe = (): void => {
      try {
        kill(groupId, 0);
      } catch (error) {
        if (isErrnoExceptionWithCode(error, 'ESRCH')) {
          finish();
          return;
        }
        if (isErrnoExceptionWithCode(error, 'EPERM')) {
          if (childExited()) finish();
          return;
        }
        finish(error);
      }
    };
    interval = setInterval(probe, 50);
    graceTimer = setTimeout(() => {
      try {
        kill(groupId, 'SIGKILL');
      } catch (error) {
        if (isErrnoExceptionWithCode(error, 'ESRCH')) {
          finish();
          return;
        }
        finish(error);
        return;
      }
      forcedVerificationTimer = setTimeout(() => {
        finish(new Error(`Process group ${groupId} remained alive after SIGKILL`));
      }, 1_000);
      probe();
    }, 2_000);
    probe();
  });
}

async function runtime(options: LocalBootstrapOptions, repositoryRoot: string, configPath: string) {
  await mkdir(options.persistTo, { recursive: true });
  const persistenceDirectory = await realpath(options.persistTo);
  if (persistenceIsInside(await realpath(repositoryRoot), persistenceDirectory))
    throw new BootstrapInputError('--persist-to resolves inside the repository');
  const runtimeDirectory = await mkdtemp(resolve(tmpdir(), 'coga-wrangler-local-'));
  const strictLocalSettlement = options.strictLocalSettlement ?? true;
  const runtimeConfigPath = await writeRuntimeConfig(
    runtimeDirectory,
    configPath,
    strictLocalSettlement,
  );
  return {
    persistenceDirectory,
    runtimeDirectory,
    runtimeConfigPath,
    strictLocalSettlement,
    wrangler: resolve(repositoryRoot, 'node_modules', '.bin', 'wrangler'),
  };
}

async function start(
  options: LocalBootstrapOptions,
  repositoryRoot: string,
  configPath: string,
  migrate: boolean,
): Promise<LocalBootstrap> {
  const context = await runtime(options, repositoryRoot, configPath);
  try {
    const commands = buildWranglerCommands(
      { ...options, persistTo: context.persistenceDirectory },
      context.runtimeConfigPath,
    );
    const migrationOutput = migrate
      ? await command(context.wrangler, commands.migrate, context.runtimeDirectory)
      : '';
    if (migrate && context.strictLocalSettlement) {
      await command(
        context.wrangler,
        [
          'd1',
          'execute',
          'DB',
          '--local',
          '--persist-to',
          context.persistenceDirectory,
          '--config',
          context.runtimeConfigPath,
          '--command',
          `INSERT OR IGNORE INTO players (id, wallet_address, handle, chain_agent_id, elo, games_played, wins, created_at) VALUES ('${LOCAL_TREASURY_ID}', '${LOCAL_TREASURY_WALLET}', '${LOCAL_TREASURY_HANDLE}', ${LOCAL_TREASURY_CHAIN_AGENT_ID}, 1200, 0, 0, '2026-01-01T00:00:00Z')`,
          '--json',
        ],
        context.runtimeDirectory,
      );
    }
    const child = spawn(context.wrangler, commands.dev, {
      cwd: context.runtimeDirectory,
      detached: true,
      env: environment(),
      stdio: 'inherit',
    });
    const processId = child.pid;
    if (!processId) throw new Error('Wrangler did not provide a process id');
    let childExited = false;
    child.once('exit', () => {
      childExited = true;
    });
    return {
      port: options.port,
      processId,
      migrationOutput,
      stop: async () => {
        try {
          await stopProcessGroup(processId, process.kill, () => childExited);
        } finally {
          await rm(context.runtimeDirectory, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    await rm(context.runtimeDirectory, { recursive: true, force: true });
    throw error;
  }
}

export function startLocalBootstrap(
  options: LocalBootstrapOptions,
  repositoryRoot: string,
  configPath: string,
): Promise<LocalBootstrap> {
  return start(options, repositoryRoot, configPath, true);
}
export function startUnmigratedLocalWorker(
  options: LocalBootstrapOptions,
  repositoryRoot: string,
  configPath: string,
): Promise<LocalBootstrap> {
  return start(options, repositoryRoot, configPath, false);
}
export async function hasAuthNoncesTable(
  options: LocalBootstrapOptions,
  repositoryRoot: string,
  configPath: string,
): Promise<boolean> {
  const output = await executeLocalD1(
    options,
    repositoryRoot,
    configPath,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'auth_nonces'",
  );
  return output.includes('auth_nonces');
}

export async function executeLocalD1(
  options: LocalBootstrapOptions,
  repositoryRoot: string,
  configPath: string,
  sql: string,
): Promise<string> {
  const context = await runtime(options, repositoryRoot, configPath);
  try {
    return await command(
      context.wrangler,
      [
        'd1',
        'execute',
        'DB',
        '--local',
        '--persist-to',
        context.persistenceDirectory,
        '--config',
        context.runtimeConfigPath,
        '--command',
        sql,
        '--json',
      ],
      context.runtimeDirectory,
    );
  } finally {
    await rm(context.runtimeDirectory, { recursive: true, force: true });
  }
}
