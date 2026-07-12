/**
 * Spec discovery — lists campaign/run YAML specs from the bounded SPEC_ROOTS
 * (workspace `runs/` + package `examples/`), non-recursive, read-only.
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { type BoundedRoot, encodePathId, resolvePathId, SPEC_ROOTS } from './paths.js';
import { redactText } from './redact.js';

export interface SpecInfo {
  id: string;
  name: string;
  root: string;
  sizeBytes: number;
  modifiedAt: string;
}

const MAX_SPECS_PER_ROOT = 100;
const MAX_PREVIEW_BYTES = 64 * 1024;
const SPEC_EXT_RE = /\.(ya?ml)$/i;

async function listRootSpecs(root: BoundedRoot): Promise<SpecInfo[]> {
  let entries: string[];
  try {
    entries = await fsp.readdir(root.dir);
  } catch {
    return []; // absent root (e.g. no runs/ dir) is an empty list, not an error
  }
  const specs: SpecInfo[] = [];
  for (const name of entries.sort().slice(0, MAX_SPECS_PER_ROOT)) {
    if (!SPEC_EXT_RE.test(name)) continue;
    try {
      const stat = await fsp.stat(path.join(root.dir, name));
      if (!stat.isFile()) continue;
      specs.push({
        id: encodePathId(root.key, name),
        name,
        root: root.label,
        sizeBytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
      });
    } catch {
      // raced deletion — skip
    }
  }
  return specs;
}

export async function listSpecs(): Promise<SpecInfo[]> {
  const perRoot = await Promise.all(SPEC_ROOTS.map((root) => listRootSpecs(root)));
  return perRoot.flat();
}

/** Resolve a spec id → its real absolute path (containment-checked). */
export async function resolveSpec(id: string): Promise<{ abs: string; name: string }> {
  const { decoded, abs } = await resolvePathId(id, SPEC_ROOTS);
  if (!SPEC_EXT_RE.test(abs)) throw new Error('spec must be a .yaml/.yml file');
  return { abs, name: decoded.rel };
}

export interface SpecPreview {
  id: string;
  name: string;
  text: string;
  truncated: boolean;
}

/** Redacted, size-capped raw text of a spec for the inspector pane. */
export async function readSpecPreview(id: string): Promise<SpecPreview> {
  const { abs, name } = await resolveSpec(id);
  const fh = await fsp.open(abs, 'r');
  try {
    const buf = Buffer.alloc(MAX_PREVIEW_BYTES + 1);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const truncated = bytesRead > MAX_PREVIEW_BYTES;
    const text = redactText(
      buf.subarray(0, Math.min(bytesRead, MAX_PREVIEW_BYTES)).toString('utf8'),
    );
    return { id, name, text, truncated };
  } finally {
    await fh.close();
  }
}
