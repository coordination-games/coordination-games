#!/usr/bin/env tsx
import { mkdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

interface SweepCase {
  name: string;
  model?: string;
  botCount?: number;
  repeats?: number;
  promptAppend?: string;
}

interface SweepConfig {
  parallel?: number;
  cases: SweepCase[];
}

interface SweepJob {
  caseName: string;
  iteration: number;
  model: string;
  botCount: number;
  promptAppend: string;
}

function parseArgs(argv: string[]) {
  const parsed: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      parsed[key] = true;
      continue;
    }
    parsed[key] = next;
    i += 1;
  }
  return parsed;
}

async function loadSweepConfig(configPath: string): Promise<SweepConfig> {
  const raw = await readFile(configPath, 'utf-8');
  return JSON.parse(raw) as SweepConfig;
}

async function runJob(job: SweepJob, serverUrl: string, outDir: string, dryRun: boolean) {
  const runLabel = `${job.caseName}-run-${job.iteration}`;
  const stdoutPath = path.join(outDir, `${runLabel}.stdout.log`);
  const stderrPath = path.join(outDir, `${runLabel}.stderr.log`);
  const startedAt = Date.now();

  if (dryRun) {
    return {
      runLabel,
      caseName: job.caseName,
      iteration: job.iteration,
      model: job.model,
      botCount: job.botCount,
      promptAppend: job.promptAppend,
      stdoutPath,
      stderrPath,
      dryRun: true,
    };
  }

  return await new Promise<Record<string, unknown>>((resolve, reject) => {
    const child = spawn('npx', ['tsx', 'scripts/run-game.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        GAME_SERVER: serverUrl,
        GAME_TYPE: 'comedy-of-the-commons',
        BOT_COUNT: String(job.botCount),
        LOBBY_SIZE: String(job.botCount),
        MODEL: job.model,
        RUN_LABEL: runLabel,
        PROMPT_APPEND: job.promptAppend,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('error', reject);
    child.on('close', (code) => {
      writeFileSync(stdoutPath, stdout, 'utf-8');
      writeFileSync(stderrPath, stderr, 'utf-8');
      resolve({
        runLabel,
        caseName: job.caseName,
        iteration: job.iteration,
        model: job.model,
        botCount: job.botCount,
        exitCode: code,
        durationMs: Date.now() - startedAt,
        stdoutPath,
        stderrPath,
      });
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const configPath = String(args.config || 'scripts/comedy-sweep.config.json');
  const caseFilter = typeof args.case === 'string' ? args.case : undefined;
  const serverUrl = String(args['server-url'] || process.env.GAME_SERVER || 'http://localhost:8787');
  const dryRun = Boolean(args['dry-run']);
  const config = await loadSweepConfig(configPath);
  const parallel = Number(args.parallel || config.parallel || 1);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(process.cwd(), 'artifacts', 'comedy-sweeps', timestamp);
  mkdirSync(outDir, { recursive: true });

  const selectedCases = config.cases.filter((entry) => !caseFilter || entry.name === caseFilter);
  const jobs: SweepJob[] = [];
  for (const entry of selectedCases) {
    const repeats = Math.max(1, entry.repeats ?? 1);
    for (let iteration = 1; iteration <= repeats; iteration++) {
      jobs.push({
        caseName: entry.name,
        iteration,
        model: entry.model ?? 'haiku',
        botCount: Math.max(4, entry.botCount ?? 4),
        promptAppend: entry.promptAppend ?? '',
      });
    }
  }

  const resultsPath = path.join(outDir, 'results.jsonl');
  const pending = [...jobs];
  const running = new Set<Promise<void>>();

  async function launch(job: SweepJob) {
    const result = await runJob(job, serverUrl, outDir, dryRun);
    writeFileSync(resultsPath, `${JSON.stringify(result)}\n`, { encoding: 'utf-8', flag: 'a' });
  }

  while (pending.length > 0 || running.size > 0) {
    while (pending.length > 0 && running.size < parallel) {
      const job = pending.shift()!;
      const promise = launch(job).finally(() => running.delete(promise));
      running.add(promise);
    }
    if (running.size > 0) {
      await Promise.race(running);
    }
  }

  process.stdout.write(`Comedy sweep complete. Artifacts: ${outDir}\n`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
