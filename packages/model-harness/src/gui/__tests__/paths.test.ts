import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type BoundedRoot,
  decodePathId,
  encodePathId,
  PathViolationError,
  resolveContained,
} from '../paths.js';

const ROOTS: BoundedRoot[] = [{ key: 'runs', label: 'runs/', dir: '/tmp/unused' }];

describe('decodePathId — syntactic traversal rejection', () => {
  it('rejects ids without a root prefix when given bare or empty input', () => {
    // Given a malformed id / When decoded / Then it is rejected before any fs access
    expect(() => decodePathId('no-colon', ROOTS)).toThrow(PathViolationError);
    expect(() => decodePathId(':rel', ROOTS)).toThrow(PathViolationError);
  });

  it('rejects unknown roots when the key is not allow-listed', () => {
    expect(() => decodePathId('etc:passwd', ROOTS)).toThrow(PathViolationError);
  });

  it('rejects dot-dot segments when they appear anywhere in the rel path', () => {
    expect(() => decodePathId('runs:../secrets', ROOTS)).toThrow(PathViolationError);
    expect(() => decodePathId('runs:a/../b', ROOTS)).toThrow(PathViolationError);
    expect(() => decodePathId('runs:..', ROOTS)).toThrow(PathViolationError);
  });

  it('rejects absolute paths, backslashes, empty and dot segments', () => {
    expect(() => decodePathId('runs:/etc/passwd', ROOTS)).toThrow(PathViolationError);
    expect(() => decodePathId('runs:a\\b', ROOTS)).toThrow(PathViolationError);
    expect(() => decodePathId('runs:a//b', ROOTS)).toThrow(PathViolationError);
    expect(() => decodePathId('runs:./a', ROOTS)).toThrow(PathViolationError);
  });

  it('round-trips a legitimate nested rel path', () => {
    // Given an encoded id / When decoded / Then root+rel are recovered verbatim
    const id = encodePathId('runs', 'campaign-1/run-2');
    const decoded = decodePathId(id, ROOTS);
    expect(decoded.root.key).toBe('runs');
    expect(decoded.rel).toBe('campaign-1/run-2');
  });

  it('rejects control characters (U+0000-U+001F, U+007F) in the rel path', () => {
    // Given ids embedding control chars / When decoded / Then rejected before any fs access
    const withCode = (code: number): string => `runs:a${String.fromCharCode(code)}b`;
    expect(() => decodePathId(withCode(0x00), ROOTS)).toThrow(PathViolationError);
    expect(() => decodePathId(withCode(0x1f), ROOTS)).toThrow(PathViolationError);
    expect(() => decodePathId(withCode(0x7f), ROOTS)).toThrow(PathViolationError);
  });
});

describe('resolveContained — realpath containment', () => {
  let rootDir: string;
  let outsideDir: string;
  const root = (): BoundedRoot => ({ key: 't', label: 't/', dir: rootDir });

  beforeAll(async () => {
    rootDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gui-root-'));
    outsideDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gui-outside-'));
    await fsp.writeFile(path.join(rootDir, 'inside.txt'), 'ok');
    await fsp.writeFile(path.join(outsideDir, 'secret.txt'), 'secret');
    await fsp.symlink(path.join(outsideDir, 'secret.txt'), path.join(rootDir, 'escape-link'));
  });

  afterAll(async () => {
    await fsp.rm(rootDir, { recursive: true, force: true });
    await fsp.rm(outsideDir, { recursive: true, force: true });
  });

  it('resolves a real file inside the root', async () => {
    // Given a file physically inside the root / When resolved / Then its realpath returns
    const abs = await resolveContained(root(), 'inside.txt');
    expect(abs).toBe(await fsp.realpath(path.join(rootDir, 'inside.txt')));
  });

  it('rejects a symlink whose target lives outside the root', async () => {
    // Given a symlink escaping the root / When resolved / Then containment fails
    await expect(resolveContained(root(), 'escape-link')).rejects.toThrow(PathViolationError);
  });

  it('rejects paths that do not exist', async () => {
    await expect(resolveContained(root(), 'missing.txt')).rejects.toThrow(PathViolationError);
  });
});
