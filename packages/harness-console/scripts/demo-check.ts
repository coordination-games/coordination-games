#!/usr/bin/env -S npx tsx
/**
 * Demo-check ritual (docs/plans/ui-rethink.md, "reliability doctrine"): the
 * one command to run before any real demo. Hits the running console's own
 * health surface — GET /api/preflight (which already covers the claude CLI,
 * coga build, game server, spectator, and runs-directory checks), plus
 * /api/demos and /api/campaigns as a smoke test that the API itself answers.
 * No process spawning, no game launch. Prints a ✓/✗ table with plain-sentence
 * fixes and exits non-zero on any fail-severity problem. Run this before a
 * real demo; a candidate for a nightly cron.
 *
 * Usage: npm run demo-check [-- --full]   (CONSOLE_URL env overrides the target)
 */

const CONSOLE_URL = (process.env.CONSOLE_URL ?? 'http://127.0.0.1:4310').replace(/\/+$/, '');

type CheckSeverity = 'fail' | 'warn';

interface PreflightCheck {
  id: string;
  label: string;
  ok: boolean;
  severity: CheckSeverity;
  detail?: string;
}

interface PreflightReport {
  ok: boolean;
  checks: PreflightCheck[];
  nodeVersion: string;
  checkedAt: number;
}

interface Row {
  label: string;
  ok: boolean;
  severity: CheckSeverity;
  detail?: string;
}

function makeRow(label: string, severity: CheckSeverity, ok: boolean, detail?: string): Row {
  if (ok) return { label, ok: true, severity };
  return { label, ok: false, severity, detail: detail ?? `${label} failed.` };
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // Non-JSON error body — keep the status line.
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

function symbol(row: Row): string {
  if (row.ok) return '\x1b[32m✓\x1b[0m';
  return row.severity === 'fail' ? '\x1b[31m✗\x1b[0m' : '\x1b[33m~\x1b[0m';
}

function printTable(rows: Row[]): void {
  const width = Math.max(...rows.map((r) => r.label.length), 'check'.length);
  for (const row of rows) {
    const line = `  ${symbol(row)} ${row.label.padEnd(width)}`;
    console.log(row.detail ? `${line}  ${row.detail}` : line);
  }
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--full')) {
    console.log(
      'full mode (launches a real 5-min demo) not implemented yet — run the commons demo from ' +
        'the UI instead',
    );
    process.exit(0);
    return;
  }

  console.log(`demo-check — console at ${CONSOLE_URL}\n`);

  const rows: Row[] = [];
  let unreachable = false;
  let preflight: PreflightReport | null = null;

  try {
    preflight = await getJson<PreflightReport>(`${CONSOLE_URL}/api/preflight`);
    for (const c of preflight.checks) {
      rows.push(makeRow(c.label, c.severity, c.ok, c.detail));
    }
  } catch (err) {
    rows.push(
      makeRow(
        'Console preflight',
        'fail',
        false,
        `Could not reach ${CONSOLE_URL}/api/preflight (${reasonOf(err)}). Is the console running?`,
      ),
    );
    unreachable = true;
  }

  try {
    const { demos } = await getJson<{ demos: unknown[] }>(`${CONSOLE_URL}/api/demos`);
    rows.push(
      makeRow(
        'Demos endpoint',
        'fail',
        demos.length > 0,
        demos.length > 0 ? undefined : 'GET /api/demos returned zero demos.',
      ),
    );
  } catch (err) {
    rows.push(
      makeRow('Demos endpoint', 'fail', false, `GET /api/demos failed (${reasonOf(err)}).`),
    );
  }

  try {
    await getJson<{ campaigns: unknown[] }>(`${CONSOLE_URL}/api/campaigns`);
    rows.push(makeRow('Campaigns endpoint', 'fail', true));
  } catch (err) {
    rows.push(
      makeRow('Campaigns endpoint', 'fail', false, `GET /api/campaigns failed (${reasonOf(err)}).`),
    );
  }

  printTable(rows);

  const fails = rows.filter((r) => !r.ok && r.severity === 'fail');
  const warns = rows.filter((r) => !r.ok && r.severity === 'warn');
  const greens = rows.length - fails.length - warns.length;

  console.log('');
  if (preflight) console.log(`node (console process): ${preflight.nodeVersion}`);
  console.log(
    `${greens}/${rows.length} green, ${warns.length} warning(s), ${fails.length} failure(s).`,
  );

  if (fails.length > 0 || unreachable) process.exit(1);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
