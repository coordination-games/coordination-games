/**
 * Artifact discovery — scans the bounded ARTIFACT_ROOTS for campaign dirs
 * (campaign.json) and run dirs (manifest.json / relay.jsonl / bots/), without
 * reading file contents. Read-only, capped, and containment-safe: ids returned
 * here are `<rootKey>:<rel>` and re-validated on every inspect call.
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { ARTIFACT_ROOTS, type BoundedRoot, encodePathId } from './paths.js';

export interface RunDirEntry {
  id: string;
  name: string;
  root: string;
  /** Parent campaign dir name when the run sits inside one. */
  campaign: string | null;
  modifiedAt: string;
  hasManifest: boolean;
  hasAnalysis: boolean;
  hasRelay: boolean;
  hasSeries: boolean;
  botFiles: number;
}

export interface CampaignDirEntry {
  id: string;
  name: string;
  root: string;
  modifiedAt: string;
  runDirs: number;
}

export interface ArtifactIndex {
  campaigns: CampaignDirEntry[];
  runs: RunDirEntry[];
}

const MAX_DIRS_PER_ROOT = 200;
const MAX_RUNS_PER_CAMPAIGN = 100;

async function exists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

async function countBotFiles(dir: string): Promise<number> {
  try {
    const names = await fsp.readdir(path.join(dir, 'bots'));
    return names.filter((n) => n.endsWith('.jsonl')).length;
  } catch {
    return 0;
  }
}

async function classifyRunDir(
  root: BoundedRoot,
  rel: string,
  abs: string,
  campaign: string | null,
): Promise<RunDirEntry | null> {
  const [hasManifest, hasAnalysis, hasRelay, hasSeries, botFiles, stat] = await Promise.all([
    exists(path.join(abs, 'manifest.json')),
    exists(path.join(abs, 'analysis.json')),
    exists(path.join(abs, 'relay.jsonl')),
    exists(path.join(abs, 'series-manifest.json')),
    countBotFiles(abs),
    fsp.stat(abs),
  ]);
  if (!hasManifest && !hasRelay && botFiles === 0 && !hasSeries) return null;
  return {
    id: encodePathId(root.key, rel),
    name: path.basename(rel),
    root: root.label,
    campaign,
    modifiedAt: stat.mtime.toISOString(),
    hasManifest,
    hasAnalysis,
    hasRelay,
    hasSeries,
    botFiles,
  };
}

async function scanRoot(root: BoundedRoot): Promise<ArtifactIndex> {
  const campaigns: CampaignDirEntry[] = [];
  const runs: RunDirEntry[] = [];
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fsp.readdir(root.dir, { withFileTypes: true });
  } catch {
    return { campaigns, runs }; // absent root = empty, not an error
  }
  const dirs = entries.filter((e) => e.isDirectory()).slice(0, MAX_DIRS_PER_ROOT);
  for (const entry of dirs) {
    const rel = entry.name;
    const abs = path.join(root.dir, rel);
    if (await exists(path.join(abs, 'campaign.json'))) {
      let subDirs: string[] = [];
      try {
        subDirs = (await fsp.readdir(abs, { withFileTypes: true }))
          .filter((e) => e.isDirectory())
          .map((e) => e.name)
          .slice(0, MAX_RUNS_PER_CAMPAIGN);
      } catch {
        // unreadable campaign dir — record it with zero runs
      }
      const stat = await fsp.stat(abs);
      campaigns.push({
        id: encodePathId(root.key, rel),
        name: rel,
        root: root.label,
        modifiedAt: stat.mtime.toISOString(),
        runDirs: subDirs.length,
      });
      for (const sub of subDirs) {
        const runEntry = await classifyRunDir(root, `${rel}/${sub}`, path.join(abs, sub), rel);
        if (runEntry) runs.push(runEntry);
      }
    } else {
      const runEntry = await classifyRunDir(root, rel, abs, null);
      if (runEntry) runs.push(runEntry);
    }
  }
  return { campaigns, runs };
}

/** Full index across all artifact roots, newest first. */
export async function listArtifacts(): Promise<ArtifactIndex> {
  const scanned = await Promise.all(ARTIFACT_ROOTS.map((root) => scanRoot(root)));
  const campaigns = scanned.flatMap((s) => s.campaigns);
  const runs = scanned.flatMap((s) => s.runs);
  campaigns.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  runs.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  return { campaigns, runs };
}
