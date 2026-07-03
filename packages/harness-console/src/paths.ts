/**
 * Path anchors for the console. Everything is resolved from this package's
 * location inside the monorepo — the console only ever reads/writes under the
 * repo's runs/ tree and ~/.coordination/.
 */

import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Monorepo root (packages/harness-console/../..). */
export const REPO_ROOT = path.resolve(pkgDir, '..', '..');

/** Where campaigns land — must match the spec `output` the console writes. */
export const OUTPUT_DIR = path.join(REPO_ROOT, 'runs', 'out');

/** Console-authored spec files, one per launched campaign. */
export const SPECS_DIR = path.join(REPO_ROOT, 'runs', 'specs');

/** Console-authored custom persona bundles (persona.md per dir). */
export const CUSTOM_PERSONAS_DIR = path.join(REPO_ROOT, 'runs', 'personas');

/** Bundled persona bundles shipped with the harness. */
export const BUNDLED_PERSONAS_DIR = path.join(REPO_ROOT, 'packages', 'model-harness', 'personas');

/** Game plugin directories (the game-type vocabulary). */
export const GAMES_DIR = path.join(REPO_ROOT, 'packages', 'games');

/** The harness CLI entry the console spawns (The One Rule: wrap, don't fork). */
export const HARNESS_ENTRY = path.join(REPO_ROOT, 'packages', 'model-harness', 'src', 'index.ts');

/** Local coga CLI source entry — console runs bots on the repo's code, not npm's. */
export const CLI_ENTRY = path.join(REPO_ROOT, 'packages', 'cli', 'src', 'index.ts');

/** Built coga CLI (npm run build:cli). Preferred over CLI_ENTRY: plain-node
 * startup is fast enough that N concurrent bots' MCP servers connect before
 * the claude session snapshots its tool list — 4 concurrent tsx compiles are
 * not (observed: seats stuck at MCP status "pending" with zero coga tools). */
export const CLI_DIST = path.join(REPO_ROOT, 'packages', 'cli', 'dist', 'index.cjs');

/** Local tsx binary (same trick as Djimo's console — no npx indirection). */
export const TSX_BIN = path.join(
  REPO_ROOT,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'tsx.cmd' : 'tsx',
);

/** Secrets file — same directory family as the harness bot pool (~/.coordination). */
export const SECRETS_DIR = path.join(homedir(), '.coordination');
export const SECRETS_FILE = path.join(SECRETS_DIR, 'console-secrets.json');

/** Reject path-segment ids that could escape their directory. */
export function assertSafeId(id: string, what: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._ -]*$/.test(id) || id.includes('..')) {
    throw new HttpError(400, `invalid ${what}: ${JSON.stringify(id)}`);
  }
}

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
