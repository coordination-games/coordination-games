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
import { resolvePersonaDir, runBatch } from './orchestrate.js';
import { expandSeatPlan, loadSpec } from './spec.js';
import type { RunSpec } from './types.js';

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
// Dry-run: resolve and print the seat plan, no side effects.
// ---------------------------------------------------------------------------

function printSeatPlan(spec: RunSpec): void {
  const plans = expandSeatPlan(spec);

  const totalSeats = plans.length;
  const backendCounts = plans.reduce<Record<string, number>>((acc, p) => {
    acc[p.backend] = (acc[p.backend] ?? 0) + 1;
    return acc;
  }, {});

  console.log('\n=== Resolved seat plan (dry run) ===\n');
  console.log(`game:       ${spec.game}`);
  console.log(`rounds:     ${spec.rounds}`);
  console.log(`server:     ${spec.server}`);
  console.log(`identities: ${spec.identities}`);
  console.log(`output:     ${spec.output}`);
  console.log(`params:     ${JSON.stringify(spec.params)}`);
  console.log(
    `limits:     maxModelCallsPerBot=${spec.limits.maxModelCallsPerBot}, ` +
      `wallClockMsPerRun=${spec.limits.wallClockMsPerRun}`,
  );
  if (spec.analysis) {
    console.log(
      `analysis:   enabled=${spec.analysis.enabled}, model=${spec.analysis.model}` +
        (spec.analysis.lenses ? `, lenses=[${spec.analysis.lenses.join(', ')}]` : ''),
    );
  } else {
    console.log('analysis:   (none)');
  }

  console.log(
    `\nseats:      ${totalSeats} total — ` +
      Object.entries(backendCounts)
        .map(([b, n]) => `${n} ${b}`)
        .join(', '),
  );
  console.log('');

  const seatRows = plans.map((p) => {
    const dir = resolvePersonaDir(p.persona);
    return {
      seat: p.seatIndex,
      persona: p.persona,
      personaDir: dir,
      model: p.model,
      backend: p.backend,
    };
  });

  for (const row of seatRows) {
    console.log(
      `  seat ${String(row.seat).padStart(2)}  ` +
        `persona=${row.persona.padEnd(26)}  ` +
        `model=${row.model.padEnd(36)}  ` +
        `backend=${row.backend}`,
    );
    console.log(`           → ${row.personaDir}`);
  }
  console.log('');
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

async function cmdRun(specPath: string, dryRun: boolean): Promise<number> {
  const spec = await loadSpec(specPath);

  if (dryRun) {
    printSeatPlan(spec);
    return 0;
  }

  const { runDir, lobbyId, gameId, manifest } = await runBatch(spec);
  console.log(`\nrun complete:`);
  console.log(`  runDir:  ${runDir}`);
  console.log(`  lobbyId: ${lobbyId}`);
  console.log(`  gameId:  ${gameId}`);
  void manifest;

  if (spec.analysis?.enabled) {
    console.log(`\n[analyze] running judge (${spec.analysis.model})...`);
    await analyzeRun(runDir, {
      model: spec.analysis.model,
      ...(spec.analysis.lenses ? { lenses: spec.analysis.lenses } : {}),
    });
    console.log(`  analysis: ${path.join(runDir, 'analysis.json')}`);
  }

  return 0;
}

// ---------------------------------------------------------------------------
// analyze
// ---------------------------------------------------------------------------

const DEFAULT_ANALYSIS_MODEL = 'anthropic/claude-haiku';

async function cmdAnalyze(runDir: string, flags: Set<string>, modelFlag?: string): Promise<number> {
  const abs = path.resolve(runDir);

  // Prefer an explicit --model flag; otherwise read the manifest's spec.analysis.
  let model = modelFlag;
  let lenses: string[] | undefined;
  if (!model) {
    try {
      const { promises: fs } = await import('node:fs');
      const manifestRaw = await fs.readFile(path.join(abs, 'manifest.json'), 'utf8');
      const manifest = JSON.parse(manifestRaw) as {
        spec?: { analysis?: { model?: string; lenses?: string[] } };
      };
      model = manifest.spec?.analysis?.model;
      lenses = manifest.spec?.analysis?.lenses;
    } catch {
      // No manifest / unreadable — fall through to default.
    }
  }
  model = model ?? DEFAULT_ANALYSIS_MODEL;
  void flags;

  console.log(`[analyze] runDir=${abs} model=${model}`);
  await analyzeRun(abs, { model, ...(lenses ? { lenses } : {}) });
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
