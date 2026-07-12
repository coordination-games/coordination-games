import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { organizationRemoteFailure } from './repository-routing.js';

export { normalizeGitHubRepository } from './repository-routing.js';

const REQUIRED_STRUCTURE_PATHS = [
  'README.md',
  'package.json',
  'packages/engine/package.json',
  'packages/games/capture-the-lobster/package.json',
  'packages/workers-server/package.json',
] as const;
const PRIVATE_ROOT_DIRECTORIES = new Set([
  '.omo',
  'Coordination-Games-SOT',
  'SOT',
  'evidence',
  'plans',
  'sot',
]);
const PRIVATE_ROOT_FILES = new Set([
  'Coordination-Games-SOT.md',
  'MASTER-SOURCE-OF-TRUTH.md',
  'ROADMAP.md',
  'SOT.md',
  'sot.md',
]);

export type GuardMode = 'full' | 'staged';

export type RepositoryGuardOptions = {
  readonly mode: GuardMode;
  readonly repository: string;
  readonly requireOrgDestination?: boolean;
};

export class RepositoryGuardError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'RepositoryGuardError';
  }
}

function gitOutput(repository: string, args: readonly string[]): Buffer {
  try {
    return execFileSync('git', ['-C', repository, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unknown git failure';
    throw new RepositoryGuardError(
      `Repository guard could not run git ${args.join(' ')}: ${detail}`,
    );
  }
}

function readNulDelimitedPaths(output: Buffer): readonly string[] {
  return output
    .toString('utf8')
    .split('\0')
    .filter((entry) => entry.length > 0);
}

function stagedPaths(repository: string): readonly string[] {
  const fields = readNulDelimitedPaths(
    gitOutput(repository, [
      'diff',
      '--cached',
      '--name-status',
      '-z',
      '-M',
      '-C',
      '--diff-filter=ACMR',
    ]),
  );
  const paths: string[] = [];

  for (let index = 0; index < fields.length; ) {
    const status = fields[index];
    if (status === undefined) {
      throw new RepositoryGuardError(
        'Repository guard received malformed staged-path output from git.',
      );
    }
    index += 1;
    const kind = status.charAt(0);
    const source = fields[index];
    if (source === undefined) {
      throw new RepositoryGuardError('Repository guard received a staged change without a path.');
    }
    index += 1;

    if (kind === 'R' || kind === 'C') {
      const destination = fields[index];
      if (destination === undefined) {
        throw new RepositoryGuardError(
          'Repository guard received a staged rename or copy without a destination.',
        );
      }
      paths.push(destination);
      index += 1;
      continue;
    }
    paths.push(source);
  }

  return paths;
}

function trackedPaths(repository: string): readonly string[] {
  return readNulDelimitedPaths(gitOutput(repository, ['ls-files', '-z']));
}

export function isForbiddenPrivatePath(value: string): boolean {
  const segments = value.split('/');
  const root = segments[0];
  if (root === undefined || root.length === 0) {
    return false;
  }
  if (PRIVATE_ROOT_DIRECTORIES.has(root)) {
    return true;
  }
  return segments.length === 1 && PRIVATE_ROOT_FILES.has(root);
}

function privatePathFailure(paths: readonly string[]): RepositoryGuardError | undefined {
  const forbidden = paths.filter(isForbiddenPrivatePath);
  if (forbidden.length === 0) {
    return undefined;
  }
  return new RepositoryGuardError(
    `Private SOT/planning/evidence material is blocked: ${forbidden
      .map((path) => JSON.stringify(path))
      .join(', ')}. Keep it outside this repository or remove it from the index.`,
  );
}

function structureFailure(paths: readonly string[]): RepositoryGuardError | undefined {
  const tracked = new Set(paths);
  const missing = REQUIRED_STRUCTURE_PATHS.filter((required) => !tracked.has(required));
  if (missing.length === 0) {
    return undefined;
  }
  return new RepositoryGuardError(
    `This checkout is not structurally the Coordination Games repository; missing ${missing.join(', ')}.`,
  );
}

export function runRepositoryGuard(options: RepositoryGuardOptions): void {
  const paths =
    options.mode === 'staged' ? stagedPaths(options.repository) : trackedPaths(options.repository);
  const pathFailure = privatePathFailure(paths);
  if (pathFailure !== undefined) {
    throw pathFailure;
  }
  if (options.mode === 'full') {
    const checkoutFailure = structureFailure(paths);
    if (checkoutFailure !== undefined) {
      throw checkoutFailure;
    }
  }
  if (options.requireOrgDestination === true) {
    const routingFailureMessage = organizationRemoteFailure(options.repository);
    const routingFailure =
      routingFailureMessage === undefined
        ? undefined
        : new RepositoryGuardError(routingFailureMessage);
    if (routingFailure !== undefined) {
      throw routingFailure;
    }
  }
}

function parseCliArguments(
  args: readonly string[],
): Pick<RepositoryGuardOptions, 'mode' | 'requireOrgDestination'> {
  let mode: GuardMode = 'full';
  let requireOrgDestination = process.env.REPOSITORY_GUARD_REQUIRE_ORG_DESTINATION === '1';

  for (const arg of args) {
    if (arg === '--staged') {
      mode = 'staged';
      continue;
    }
    if (arg === '--full') {
      mode = 'full';
      continue;
    }
    if (arg === '--require-org-destination') {
      requireOrgDestination = true;
      continue;
    }
    throw new RepositoryGuardError(`Unknown repository guard option: ${arg}`);
  }

  return { mode, requireOrgDestination };
}

function main(): void {
  try {
    const options = parseCliArguments(process.argv.slice(2));
    runRepositoryGuard({ repository: process.cwd(), ...options });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`repository guard: ${detail}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
