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

import path from 'node:path';
import { analyzeRun } from './analyze.js';
import { runCampaign } from './campaign-run.js';
import { renderDryRunPlan } from './dry-run-plan.js';
import {
  ImportBotConfigArgumentError,
  parseImportBotConfigArgs,
} from './import-bot-config-cli-args.js';
import { importBotConfig } from './legacy-bot-config-importer.js';
import { loadCampaign } from './spec.js';
import type { CampaignRun } from './types.js';

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
  coga-harness import-bot-config <legacy.json> [--default-provider <provider>]
                                           [--default-model <model>] [--default-base-url <url>]
                                           [--default-api-key-env <env>] [--output <yaml>]
                                           Convert legacy bot config to canonical model profiles.

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

async function cmdImportBotConfig(argv: readonly string[]): Promise<number> {
  let args: ReturnType<typeof parseImportBotConfigArgs>;
  try {
    args = parseImportBotConfigArgs(argv, process.cwd());
  } catch (err) {
    if (err instanceof ImportBotConfigArgumentError) {
      console.error(`error: ${err.message}`);
      return 1;
    }
    throw err;
  }
  const result = await importBotConfig(args.inputPath, args.outputPath, args.defaults);
  console.log(`[import-bot-config] wrote ${args.outputPath}`);
  console.log(`[import-bot-config] profiles: ${result.profileNames.join(', ')}`);
  for (const [profileName, fields] of Object.entries(result.omittedPersonaFields)) {
    console.log(
      `[import-bot-config] omitted persona fields for ${profileName}: ${fields.join(', ')}`,
    );
  }
  return 0;
}

/** Print the resolved run plan for a dry run (the expanded grid + total count). */
function printPlan(runs: CampaignRun[]): void {
  console.log(renderDryRunPlan(runs));
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

    case 'import-bot-config': {
      return cmdImportBotConfig(process.argv.slice(3));
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
