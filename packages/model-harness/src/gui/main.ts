#!/usr/bin/env -S npx tsx
/**
 * coga-harness GUI — thin entry for the local-only browser console.
 *
 * Usage:
 *   npm run gui -w packages/model-harness            # http://127.0.0.1:4319
 *   HARNESS_GUI_PORT=5000 npm run gui -w packages/model-harness
 *
 * The console drives the existing CLI (`tsx src/index.ts run [--dry-run]`),
 * streams redacted output, and audits artifact dirs under runs/out/ and the
 * package examples/. It binds loopback ONLY; HARNESS_GUI_HOST may pick a
 * different loopback address but non-loopback values are refused.
 */

import { startGuiServer } from './server.js';

const HELP = `coga-harness gui — local-only browser console for the Unified Model Harness

Usage:
  npm run gui -w packages/model-harness

Environment:
  HARNESS_GUI_PORT   Port to listen on (default 4319).
  HARNESS_GUI_HOST   Loopback address to bind (default 127.0.0.1).
                     Non-loopback hosts are refused — this console is local-only.

Surfaces:
  Specs      YAML campaign specs from <repo>/runs and <pkg>/examples.
  Runs       Launch/stop 'run' and '--dry-run' through src/index.ts; live
             redacted stdout/stderr via SSE.
  Artifacts  campaign.json / manifest.json / analysis.json / relay.jsonl /
             bots/*.jsonl audit with counts, identifiers, and parse issues.

Notes:
  - A reachable GAME_SERVER (default http://localhost:8787) is required for
    live runs; dry-runs need no network.
  - The GUI never stores API keys and redacts secrets from every surface.
`;

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(HELP);
    return;
  }
  const port = Number.parseInt(process.env.HARNESS_GUI_PORT ?? '4319', 10);
  const host = process.env.HARNESS_GUI_HOST ?? '127.0.0.1';
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`invalid HARNESS_GUI_PORT: ${process.env.HARNESS_GUI_PORT}`);
  }
  await startGuiServer({ host, port });
  console.log(`[gui] harness console listening on http://${host}:${port} (loopback only)`);
  console.log('[gui] Ctrl-C stops the console and kills any live harness child.');
}

main().catch((err: unknown) => {
  console.error(`[gui] fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
