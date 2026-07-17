import { isAbsolute, parse, relative, resolve } from 'node:path';

const DEFAULT_PORT = 8799;

export class BootstrapInputError extends Error {
  readonly name = 'BootstrapInputError';
}

export type LocalBootstrapOptions = {
  readonly persistTo: string;
  readonly port: number;
};

export type WranglerCommands = {
  readonly migrate: readonly string[];
  readonly dev: readonly string[];
};

function isInside(parent: string, candidate: string): boolean {
  const pathFromParent = relative(parent, candidate);
  return pathFromParent === '' || (!pathFromParent.startsWith('..') && !isAbsolute(pathFromParent));
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new BootstrapInputError('port must be an integer between 1024 and 65535');
  }
  return port;
}

export function parseBootstrapOptions(
  argumentsList: readonly string[],
  repositoryRoot: string,
): LocalBootstrapOptions {
  let persistTo: string | undefined;
  let port = DEFAULT_PORT;
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === undefined) continue;
    if (argument === '--remote' || argument.startsWith('--remote=')) {
      throw new BootstrapInputError('remote Wrangler commands are forbidden');
    }
    if (argument === '--persist-to') {
      const value = argumentsList[index + 1];
      if (!value) throw new BootstrapInputError('--persist-to requires an absolute directory');
      persistTo = value;
      index += 1;
      continue;
    }
    if (argument === '--port') {
      const value = argumentsList[index + 1];
      if (!value) throw new BootstrapInputError('--port requires a value');
      port = parsePort(value);
      index += 1;
      continue;
    }
    throw new BootstrapInputError(`unsupported local bootstrap option: ${argument}`);
  }
  if (!persistTo) throw new BootstrapInputError('--persist-to is required');
  if (!isAbsolute(persistTo))
    throw new BootstrapInputError('--persist-to must be an absolute directory');
  const resolvedPersistence = resolve(persistTo);
  if (
    parse(resolvedPersistence).root === resolvedPersistence ||
    isInside(resolve(repositoryRoot), resolvedPersistence)
  ) {
    throw new BootstrapInputError(
      '--persist-to must be outside the repository and cannot be a filesystem root',
    );
  }
  return { persistTo: resolvedPersistence, port };
}

export function buildWranglerCommands(
  options: LocalBootstrapOptions,
  configPath: string,
): WranglerCommands {
  return {
    migrate: [
      'd1',
      'migrations',
      'apply',
      'DB',
      '--local',
      '--persist-to',
      options.persistTo,
      '--config',
      configPath,
    ],
    dev: [
      'dev',
      '--local',
      '--persist-to',
      options.persistTo,
      '--ip',
      '127.0.0.1',
      '--port',
      String(options.port),
      '--config',
      configPath,
      '--show-interactive-dev-session',
      'false',
    ],
  };
}

export function persistenceIsInside(repositoryRoot: string, persistenceDirectory: string): boolean {
  return isInside(repositoryRoot, persistenceDirectory);
}
