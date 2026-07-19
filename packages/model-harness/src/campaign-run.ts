import { promises as fs } from 'node:fs';
import path from 'node:path';
import { analyzeRun } from './analyze.js';
import { runBatch } from './orchestrate.js';
import type { CampaignRun } from './types.js';

export type CampaignDependencies = {
  readonly runBatch: typeof runBatch;
  readonly analyzeRun: typeof analyzeRun;
  readonly now: () => number;
  readonly log: (message: string) => void;
  readonly error: (message: string) => void;
};

type CampaignRunSummary = {
  readonly label: string;
  readonly game: string;
  readonly status: 'ok' | 'error';
  readonly runDir?: string;
  readonly lobbyId?: string;
  readonly gameId?: string;
  readonly analysis?: boolean;
  readonly outcome?: unknown;
  readonly error?: string;
};

const DEFAULT_DEPENDENCIES: CampaignDependencies = {
  runBatch,
  analyzeRun,
  now: Date.now,
  log: (message) => console.log(message),
  error: (message) => console.error(message),
};

export async function runCampaign(
  runs: readonly CampaignRun[],
  overrides: Partial<CampaignDependencies> = {},
): Promise<number> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  const first = runs[0];
  if (!first) throw new Error('campaign resolved to zero runs');

  const campaignId = `campaign-${dependencies.now()}`;
  const campaignDir = path.resolve(first.spec.output, campaignId);
  await fs.mkdir(campaignDir, { recursive: true });
  dependencies.log(`\n[campaign] ${campaignId} — ${runs.length} runs → ${campaignDir}\n`);

  const summaries: CampaignRunSummary[] = [];
  for (let index = 0; index < runs.length; index++) {
    const campaignRun = runs[index];
    if (!campaignRun) continue;
    const label = campaignRun.spec.label ?? campaignRun.baseLabel;
    const tag = `[${index + 1}/${runs.length}] ${label}`;
    dependencies.log(`\n========== ${tag} ==========`);
    const spec = { ...campaignRun.spec, output: campaignDir };
    try {
      const { runDir, lobbyId, gameId, manifest } = await dependencies.runBatch(spec);
      const terminalFailure = manifestFailure(manifest);
      if (terminalFailure) {
        dependencies.error(`  [campaign] ${tag} ✗ FAILED: ${terminalFailure}`);
        summaries.push({
          label,
          game: spec.game,
          status: 'error',
          runDir: path.relative(campaignDir, runDir),
          lobbyId,
          gameId,
          error: terminalFailure,
        });
        continue;
      }
      let analysis = false;
      try {
        if (spec.analysis?.enabled) {
          await dependencies.analyzeRun(runDir, { model: spec.analysis.model });
          analysis = true;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        dependencies.error(`  [campaign] analysis failed for ${label}: ${message}`);
      }
      const outcome = isRecord(manifest) ? (manifest.outcome ?? null) : null;
      summaries.push({
        label,
        game: spec.game,
        status: 'ok',
        runDir: path.relative(campaignDir, runDir),
        lobbyId,
        gameId,
        analysis,
        outcome,
      });
      dependencies.log(`  [campaign] ${tag} ✓`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      dependencies.error(`  [campaign] ${tag} ✗ FAILED: ${message}`);
      summaries.push({ label, game: spec.game, status: 'error', error: message });
    }
  }

  const indexPath = path.join(campaignDir, 'campaign.json');
  await fs.writeFile(
    indexPath,
    JSON.stringify({ campaignId, total: runs.length, runs: summaries }, null, 2),
  );
  printCampaignSummary(summaries, indexPath, dependencies.log);
  return summaries.some((summary) => summary.status === 'error') ? 1 : 0;
}

function printCampaignSummary(
  summaries: readonly CampaignRunSummary[],
  indexPath: string,
  log: CampaignDependencies['log'],
): void {
  log('\n=== Campaign complete ===');
  for (const summary of summaries) {
    if (summary.status === 'ok') {
      const outcome = isRecord(summary.outcome) ? summary.outcome : undefined;
      const winner = typeof outcome?.winnerLabel === 'string' ? outcome.winnerLabel : '(tie/none)';
      log(`  ✓ ${summary.label.padEnd(28)} ${summary.game.padEnd(26)} winner=${winner}`);
    } else {
      log(
        `  ✗ ${summary.label.padEnd(28)} ${summary.game.padEnd(26)} ERROR: ${(summary.error ?? '').slice(0, 80)}`,
      );
    }
  }
  const succeeded = summaries.filter((summary) => summary.status === 'ok').length;
  log(`\n  ${succeeded}/${summaries.length} ok → ${indexPath}\n`);
}

function manifestFailure(manifest: unknown): string | undefined {
  const value = isRecord(manifest) ? manifest : undefined;
  if (typeof value?.status !== 'string' || value.status === 'completed') return undefined;
  return typeof value.error === 'string' && value.error.trim()
    ? value.error
    : `Run ended with status ${value.status}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
