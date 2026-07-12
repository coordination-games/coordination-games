/**
 * Bounded filesystem roots + traversal-proof resolution for the harness GUI.
 *
 * Every path the GUI reads (specs, artifacts) or hands to a spawn MUST resolve
 * inside one of the roots below. Resolution is two-stage:
 *   1. syntactic — ids are `<rootKey>:<relPath>`; the rel part rejects absolute
 *      paths, `..`/`.` segments, and control characters before any fs call;
 *   2. realpath containment — the resolved target's realpath must sit inside
 *      the root's realpath, so symlinks cannot escape the sandbox.
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Package root = two levels up from this file (src/gui/paths.ts → <pkg>). */
export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
/** Workspace root = two levels up from the package (packages/model-harness). */
export const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');

export interface BoundedRoot {
  /** Stable id-prefix for this root (used in `<key>:<rel>` ids). */
  key: string;
  /** Human label shown in the console. */
  label: string;
  /** Absolute directory this root grants access to. */
  dir: string;
}

/** Where campaign/run YAML specs are discovered (read-only). */
export const SPEC_ROOTS: readonly BoundedRoot[] = [
  { key: 'runs', label: 'runs/', dir: path.join(REPO_ROOT, 'runs') },
  { key: 'examples', label: 'examples/', dir: path.join(PACKAGE_ROOT, 'examples') },
];

/** Where run/campaign artifact directories are discovered (read-only). */
export const ARTIFACT_ROOTS: readonly BoundedRoot[] = [
  { key: 'out', label: 'runs/out/', dir: path.join(REPO_ROOT, 'runs', 'out') },
  { key: 'examples', label: 'examples/', dir: path.join(PACKAGE_ROOT, 'examples') },
];

/** Raised for every id/path that fails containment. Message is client-safe. */
export class PathViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathViolationError';
  }
}

export interface DecodedPath {
  root: BoundedRoot;
  /** Normalized POSIX-style relative path ('' = the root itself). */
  rel: string;
}

/** True when the string contains an ASCII control character (U+0000-U+001F, U+007F). */
function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** Encode a root + relative path into a client-facing id. */
export function encodePathId(rootKey: string, rel: string): string {
  return `${rootKey}:${rel.split(path.sep).join('/')}`;
}

/**
 * Decode and syntactically validate a client-supplied id. Rejects unknown
 * roots, absolute rels, dot/dot-dot segments, empty segments, backslashes,
 * and control characters. Does NOT touch the filesystem.
 */
export function decodePathId(id: string, roots: readonly BoundedRoot[]): DecodedPath {
  const sep = id.indexOf(':');
  if (sep <= 0) throw new PathViolationError('malformed id (expected <root>:<path>)');
  const rootKey = id.slice(0, sep);
  const rel = id.slice(sep + 1);
  const root = roots.find((r) => r.key === rootKey);
  if (!root) throw new PathViolationError(`unknown root "${rootKey}"`);
  assertSafeRel(rel);
  return { root, rel };
}

/** Syntactic guard for a relative path (no fs access). */
export function assertSafeRel(rel: string): void {
  if (rel === '') return; // the root itself
  if (rel.includes('\\')) throw new PathViolationError('backslashes are not allowed');
  if (hasControlChar(rel)) throw new PathViolationError('control characters are not allowed');
  if (path.posix.isAbsolute(rel) || path.isAbsolute(rel)) {
    throw new PathViolationError('absolute paths are not allowed');
  }
  for (const segment of rel.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new PathViolationError('path segments "", "." and ".." are not allowed');
    }
  }
}

/**
 * Resolve `rel` inside `root` and prove containment via realpath. The target
 * must exist; symlinked escapes resolve outside the root's realpath and are
 * rejected. Returns the real absolute path, safe to read or stat.
 */
export async function resolveContained(root: BoundedRoot, rel: string): Promise<string> {
  assertSafeRel(rel);
  let rootReal: string;
  try {
    rootReal = await fsp.realpath(root.dir);
  } catch {
    throw new PathViolationError(`root "${root.key}" is not available`);
  }
  const candidate = rel === '' ? rootReal : path.resolve(rootReal, rel);
  let real: string;
  try {
    real = await fsp.realpath(candidate);
  } catch {
    throw new PathViolationError('no such file inside the allowed roots');
  }
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
    throw new PathViolationError('path escapes its allowed root');
  }
  return real;
}

/** Decode an id against `roots` and resolve it with containment in one step. */
export async function resolvePathId(
  id: string,
  roots: readonly BoundedRoot[],
): Promise<{ decoded: DecodedPath; abs: string }> {
  const decoded = decodePathId(id, roots);
  const abs = await resolveContained(decoded.root, decoded.rel);
  return { decoded, abs };
}

/** Display path relative to the workspace root (for provenance UI). */
export function displayPath(abs: string): string {
  const rel = path.relative(REPO_ROOT, abs);
  return rel.startsWith('..') ? path.basename(abs) : rel.split(path.sep).join('/');
}
