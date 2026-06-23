#!/usr/bin/env -S npx tsx
/**
 * coga-harness — CLI entry for the Unified Model Harness.
 *
 * Subcommands:
 *   run <spec.yaml>              Load the spec, run a full batch, then (if
 *                                analysis.enabled) run the judge pass.
 *   run --dry-run <spec.yaml>    Resolve + print the seat plan and exit. No
 *                                network, no wallets, no subprocesses.
 *   analyze <runDir>             Run the judge pass over an existing run dir.
 *
 * This binary is the SOLE agent-facing entry for the harness — there is no
 * separate MCP surface; the harness drives bots through `coga serve --stdio`.
 *
 * References: docs/plans/unified-model-harness.md §§4.5, 6, 7, 10.
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { analyzeRun } from './analyze.js';
import { runBatch } from './orchestrate.js';
import { expandSeatPlan, loadCampaign } from './spec.js';
import type { CampaignRun, RunSpec } from './types.js';

// ---------------------------------------------------------------------------
// argv parsing — deliberately minimal (§: no arg-parsing dependency).
// ---------------------------------------------------------------------------

interface ParsedArgs {
  command: string | undefined;
  positionals: string[];
  flags: Set<string>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Set<string>();
  const positionals: string[] = [];
  for (const arg of argv) {
    if (arg.startsWith('--')) {
      flags.add(arg.slice(2));
    } else {
      positionals.push(arg);
    }
  }
  const command = positionals.shift();
  return { command, positionals, flags };
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

const USAGE = `coga-harness — Unified Model Harness

Usage:
  coga-harness run <spec.yaml>            Run a full batch (and analysis if enabled).
  coga-harness run --dry-run <spec.yaml>  Print the resolved seat plan and exit.
  coga-harness analyze <runDir>           Run the judge analysis over a run dir.

Notes:
  - Persona refs in a spec may be absolute paths, package-relative paths
    (./personas/...), or bare bundled-persona names (e.g. peaceful-mediator).
  - 'run' requires a reachable GAME_SERVER (default http://localhost:8787) and,
    for any openrouter-backed seat, OPENROUTER_API_KEY (or OPENAI_API_KEY).
  - 'analyze' uses the judge model in the run's spec (or pass --model when
    analyzing a dir whose manifest lacks analysis config — falls back to a
    sensible default).
`;

// ---------------------------------------------------------------------------
// run — every spec is a list of runs (1 or many); always go through runCampaign.
// ---------------------------------------------------------------------------

async function cmdRun(specPath: string, dryRun: boolean): Promise<number> {
  const runs = await loadCampaign(specPath);
  if (dryRun) {
    printPlan(runs);
    return 0;
  }
  return runCampaign(runs);
}

// ---------------------------------------------------------------------------
// Run execution — sequential, failure-isolated, grouped under one campaign dir.
// ---------------------------------------------------------------------------

interface CampaignRunSummary {
  label: string;
  game: string;
  status: 'ok' | 'error';
  runDir?: string;
  lobbyId?: string;
  gameId?: string;
  analysis?: boolean;
  outcome?: unknown;
  error?: string;
}

/**
 * Run a campaign: every run is its own batch (fresh lobby/game/run dir), executed
 * SEQUENTIALLY under one campaign dir. One run failing does NOT abort the sweep —
 * its error is recorded and the next run proceeds (load-bearing for overnight
 * sweeps). A campaign.json index + a console summary are written at the end.
 */
async function runCampaign(runs: CampaignRun[]): Promise<number> {
  const first = runs[0];
  if (!first) throw new Error('campaign resolved to zero runs');

  // Group the whole sweep under one campaign dir so its runs are easy to compare.
  const campaignId = `campaign-${Date.now()}`;
  const campaignDir = path.resolve(first.spec.output, campaignId);
  await fsp.mkdir(campaignDir, { recursive: true });
  console.log(`\n[campaign] ${campaignId} — ${runs.length} runs → ${campaignDir}\n`);

  const summaries: CampaignRunSummary[] = [];

  for (let i = 0; i < runs.length; i++) {
    const cr = runs[i];
    if (!cr) continue;
    const label = cr.spec.label ?? cr.baseLabel;
    const tag = `[${i + 1}/${runs.length}] ${label}`;
    console.log(`\n========== ${tag} ==========`);
    // Each run writes into the campaign dir.
    const spec: RunSpec = { ...cr.spec, output: campaignDir };
    try {
      const { runDir, lobbyId, gameId, manifest } = await runBatch(spec);
      let analysis = false;
      try {
        if (spec.analysis?.enabled) {
          await analyzeRun(runDir, { model: spec.analysis.model });
          analysis = true;
        }
      } catch (err) {
        console.error(`  [campaign] analysis failed for ${label}: ${errMsg(err)}`);
      }
      const outcome = (manifest as { outcome?: unknown } | null)?.outcome ?? null;
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
      console.log(`  [campaign] ${tag} ✓`);
    } catch (err) {
      console.error(`  [campaign] ${tag} ✗ FAILED: ${errMsg(err)}`);
      summaries.push({ label, game: spec.game, status: 'error', error: errMsg(err) });
    }
  }

  const indexPath = path.join(campaignDir, 'campaign.json');
  await fsp.writeFile(
    indexPath,
    JSON.stringify({ campaignId, total: runs.length, runs: summaries }, null, 2),
  );

  printCampaignSummary(summaries, indexPath);
  return summaries.some((s) => s.status === 'error') ? 1 : 0;
}

function printCampaignSummary(summaries: CampaignRunSummary[], indexPath: string): void {
  console.log(`\n=== Campaign complete ===`);
  for (const s of summaries) {
    if (s.status === 'ok') {
      const o = s.outcome as { winnerLabel?: string } | null;
      const winner = o?.winnerLabel ?? '(tie/none)';
      console.log(`  ✓ ${s.label.padEnd(28)} ${s.game.padEnd(26)} winner=${winner}`);
    } else {
      console.log(
        `  ✗ ${s.label.padEnd(28)} ${s.game.padEnd(26)} ERROR: ${(s.error ?? '').slice(0, 80)}`,
      );
    }
  }
  const ok = summaries.filter((s) => s.status === 'ok').length;
  console.log(`\n  ${ok}/${summaries.length} ok → ${indexPath}\n`);
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Print the resolved run plan for a dry run (the expanded grid + total count). */
function printPlan(runs: CampaignRun[]): void {
  console.log('\n=== Run plan (dry run) ===\n');
  const first = runs[0]?.spec;
  if (first) {
    console.log(`server:     ${first.server}`);
    console.log(`identities: ${first.identities}`);
    console.log(`output:     ${first.output}`);
    console.log(`analysis:   ${first.analysis ? `enabled (${first.analysis.model})` : '(none)'}`);
  }

  // Group by base label (an entry = one or more repeats sharing a base label).
  const byLabel = new Map<string, CampaignRun[]>();
  for (const r of runs) {
    const arr = byLabel.get(r.baseLabel);
    if (arr) arr.push(r);
    else byLabel.set(r.baseLabel, [r]);
  }

  console.log(`\nentries:    ${byLabel.size}  |  total runs: ${runs.length}\n`);
  for (const [label, group] of byLabel) {
    const s = group[0]?.spec;
    if (!s) continue;
    const seatPlan = expandSeatPlan(s);
    const mix = seatPlan.reduce<Record<string, number>>((acc, p) => {
      acc[p.backend] = (acc[p.backend] ?? 0) + 1;
      return acc;
    }, {});
    const mixStr = Object.entries(mix)
      .map(([b, n]) => `${n} ${b}`)
      .join(', ');
    const teamSize = (s.params as { teamSize?: unknown }).teamSize ?? '?';
    console.log(
      `  ${label.padEnd(26)} game=${s.game.padEnd(26)} rounds=${String(s.rounds).padEnd(3)} teamSize=${String(teamSize).padEnd(3)} ×${group.length}  [${mixStr}]`,
    );
  }
  console.log('');
  if (runs.length > 12) {
    console.log(
      `  ⚠ ${runs.length} runs will execute sequentially — that's a lot. Ctrl-C to abort.\n`,
    );
  }
}

// ---------------------------------------------------------------------------
// analyze
// ---------------------------------------------------------------------------

const DEFAULT_ANALYSIS_MODEL = 'anthropic/claude-haiku';

async function cmdAnalyze(runDir: string, flags: Set<string>, modelFlag?: string): Promise<number> {
  const abs = path.resolve(runDir);

  // Prefer an explicit --model flag; otherwise read the manifest's spec.analysis.
  let model = modelFlag;
  if (!model) {
    try {
      const { promises: fs } = await import('node:fs');
      const manifestRaw = await fs.readFile(path.join(abs, 'manifest.json'), 'utf8');
      const manifest = JSON.parse(manifestRaw) as {
        spec?: { analysis?: { model?: string } };
      };
      model = manifest.spec?.analysis?.model;
    } catch {
      // No manifest / unreadable — fall through to default.
    }
  }
  model = model ?? DEFAULT_ANALYSIS_MODEL;
  void flags;

  console.log(`[analyze] runDir=${abs} model=${model}`);
  await analyzeRun(abs, { model });
  console.log(`  analysis: ${path.join(abs, 'analysis.json')}`);
  return 0;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const { command, positionals, flags } = parseArgs(process.argv.slice(2));

  if (!command || flags.has('help') || command === 'help') {
    console.log(USAGE);
    return command ? 0 : 1;
  }

  switch (command) {
    case 'run': {
      const specPath = positionals[0];
      if (!specPath) {
        console.error('error: `run` requires a <spec.yaml> path.\n');
        console.log(USAGE);
        return 1;
      }
      return cmdRun(specPath, flags.has('dry-run'));
    }

    case 'analyze': {
      const runDir = positionals[0];
      if (!runDir) {
        console.error('error: `analyze` requires a <runDir> path.\n');
        console.log(USAGE);
        return 1;
      }
      // Support `analyze <dir> --model <id>`: pull the value after --model.
      const modelIdx = process.argv.indexOf('--model');
      const modelFlag =
        modelIdx !== -1 && process.argv[modelIdx + 1] ? process.argv[modelIdx + 1] : undefined;
      return cmdAnalyze(runDir, flags, modelFlag);
    }

    default:
      console.error(`error: unknown command "${command}".\n`);
      console.log(USAGE);
      return 1;
  }
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((err) => {
    console.error(
      '\n[coga-harness] fatal:',
      err instanceof Error ? (err.stack ?? err.message) : err,
    );
    process.exit(1);
  });
