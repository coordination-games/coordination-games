#!/usr/bin/env -S npx tsx
/**
 * Campaign Console server — loopback-only HTTP API + static host for the
 * built web UI (web/dist). Plain node:http, no framework (same posture as
 * Djimo's console). See docs/plans/campaign-console.md.
 *
 * Dev:   npm run server -w packages/harness-console   (API on :4310)
 *        npm run dev    -w packages/harness-console   (Vite on :5175, proxies /api)
 * Built: npm run build  -w packages/harness-console, then just the server.
 */

import { promises as fsp } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  aggregateModels,
  listCampaigns,
  readAnalysis,
  readRelay,
  readRun,
  readTranscript,
} from './artifacts.js';
import { DEMO_GAME_SERVER, DEMOS } from './demos.js';
import { buildFindings, buildFindingsHtml } from './findings.js';
import { gameServerStatus, startGameServer, stopGameServer } from './game-server.js';
import {
  activeCampaignIds,
  attachJobEvents,
  listJobs,
  startAnalyze,
  startCampaign,
  stopJob,
} from './jobs.js';
import { fetchLiveFeed } from './live.js';
import { consoleMeta, saveCustomPersona } from './meta.js';
import { assertSafeId, HttpError, OUTPUT_DIR } from './paths.js';
import { assertClaudeCli, runPreflight } from './preflight.js';
import { deleteSecret, isSecretName, secretStatus, setSecret } from './secrets.js';

const PORT = Number.parseInt(process.env.CONSOLE_PORT ?? '4310', 10);
const HOST = process.env.CONSOLE_HOST ?? '127.0.0.1';
const WEB_DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'dist');

// --- tiny request helpers ------------------------------------------------------

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > 1_000_000) throw new HttpError(413, 'body too large');
    chunks.push(buf);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid JSON body');
  }
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body);
}

function asRecord(v: unknown): Record<string, unknown> {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  throw new HttpError(400, 'expected a JSON object body');
}

// --- campaign spec validation (minimal — the harness's loader is authoritative) --

interface LaunchPayload {
  spec: Record<string, unknown>;
  customPersonas?: { name: string; text: string }[];
}

async function prepareLaunch(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const payload = body as unknown as LaunchPayload;
  const spec = asRecord(payload.spec);
  const games = spec.games;
  if (!Array.isArray(games) || games.length === 0) {
    throw new HttpError(400, 'spec.games must be a non-empty array');
  }

  // Persist inline custom personas as bundles; rewrite seat refs name → abs dir.
  const refByName = new Map<string, string>();
  for (const p of payload.customPersonas ?? []) {
    if (!p?.name || !p?.text) throw new HttpError(400, 'customPersonas need name + text');
    refByName.set(p.name, await saveCustomPersona(p.name, p.text));
  }
  if (refByName.size > 0) {
    for (const entry of games) {
      const seats = (entry as Record<string, unknown>).seats;
      if (!Array.isArray(seats)) continue;
      for (const seat of seats) {
        const s = seat as Record<string, unknown>;
        const ref = refByName.get(String(s.persona ?? ''));
        if (ref) s.persona = ref;
      }
    }
  }

  // Anchor output to the console's scan dir unless the caller overrode it.
  const globals = asRecord(spec.globals ?? {});
  if (!globals.output) globals.output = OUTPUT_DIR;
  spec.globals = globals;
  return spec;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Block until the game server answers, starting it if it's down and polling
 * every 2s up to 90s. A demo must never surface a stack trace: the only way
 * out of here is success or an HttpError with a plain-English message, which
 * the route() catch handler turns into JSON with no stack, same as any other
 * route failure.
 */
async function ensureGameServer(target: string): Promise<void> {
  if ((await gameServerStatus(target)).reachable) return;
  startGameServer();
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    await sleep(2000);
    if ((await gameServerStatus(target)).reachable) return;
  }
  throw new HttpError(
    503,
    'The game server is taking too long to start. Please try the demo again in a minute.',
  );
}

// --- router --------------------------------------------------------------------

async function route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const { pathname } = url;
  const method = req.method ?? 'GET';

  if (pathname === '/api/meta' && method === 'GET') {
    return sendJson(res, 200, await consoleMeta());
  }

  if (pathname === '/api/preflight' && method === 'GET') {
    return sendJson(res, 200, await runPreflight());
  }

  if (pathname === '/api/campaigns' && method === 'GET') {
    return sendJson(res, 200, { campaigns: await listCampaigns(activeCampaignIds()) });
  }
  if (pathname === '/api/campaigns' && method === 'POST') {
    const spec = await prepareLaunch(asRecord(await readBody(req)));
    return sendJson(res, 201, await startCampaign(spec));
  }

  if (pathname === '/api/demos' && method === 'GET') {
    return sendJson(res, 200, {
      demos: DEMOS.map(({ id, title, question, blurb, estMinutes }) => ({
        id,
        title,
        question,
        blurb,
        estMinutes,
      })),
    });
  }
  const demoRunMatch = /^\/api\/demos\/([^/]+)\/run$/.exec(pathname);
  if (demoRunMatch && method === 'POST') {
    const id = decodeURIComponent(demoRunMatch[1] ?? '');
    const demo = DEMOS.find((d) => d.id === id);
    if (!demo) throw new HttpError(404, `no such demo: ${id}`);
    await assertClaudeCli();
    await ensureGameServer(DEMO_GAME_SERVER);
    const spec = await prepareLaunch({ spec: demo.spec });
    return sendJson(res, 201, await startCampaign(spec));
  }

  // /api/runs/:campaign/:run[/analysis|/relay|/transcript/:bot]
  const runMatch =
    /^\/api\/runs\/([^/]+)\/([^/]+)(?:\/(analysis|relay|transcript)(?:\/([^/]+))?)?$/.exec(
      pathname,
    );
  if (runMatch && method === 'GET') {
    const campaignId = decodeURIComponent(runMatch[1] ?? '');
    const runId = decodeURIComponent(runMatch[2] ?? '');
    const sub = runMatch[3];
    if (!sub) return sendJson(res, 200, await readRun(campaignId, runId));
    if (sub === 'analysis') return sendJson(res, 200, await readAnalysis(campaignId, runId));
    if (sub === 'relay') {
      return sendJson(res, 200, { messages: await readRelay(campaignId, runId) });
    }
    const bot = decodeURIComponent(runMatch[4] ?? '');
    if (!bot) throw new HttpError(400, 'transcript requires a bot name');
    const offset = Number.parseInt(url.searchParams.get('offset') ?? '0', 10) || 0;
    return sendJson(res, 200, await readTranscript(campaignId, runId, bot, offset));
  }

  if (pathname === '/api/analyze' && method === 'POST') {
    const body = asRecord(await readBody(req));
    const campaignId = String(body.campaign ?? '');
    const runId = String(body.run ?? '');
    assertSafeId(campaignId, 'campaign id');
    assertSafeId(runId, 'run id');
    const model = body.model ? String(body.model) : undefined;
    const runDir = path.join(OUTPUT_DIR, campaignId, runId);
    return sendJson(res, 201, await startAnalyze(runDir, model));
  }

  if (pathname === '/api/aggregate' && method === 'GET') {
    return sendJson(res, 200, { models: await aggregateModels() });
  }

  const findingsMatch = /^\/api\/campaigns\/([^/]+)\/findings(\.html)?$/.exec(pathname);
  if (findingsMatch && method === 'GET') {
    const campaignId = decodeURIComponent(findingsMatch[1] ?? '');
    const findings = await buildFindings(campaignId);
    if (findingsMatch[2]) {
      const html = buildFindingsHtml(findings);
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-disposition': `attachment; filename="${campaignId}-findings.html"`,
      });
      return void res.end(html);
    }
    return sendJson(res, 200, findings);
  }

  if (pathname === '/api/jobs' && method === 'GET') {
    return sendJson(res, 200, { jobs: listJobs() });
  }

  const liveFeedMatch = /^\/api\/live\/([^/]+)\/feed$/.exec(pathname);
  if (liveFeedMatch && method === 'GET') {
    const gameId = decodeURIComponent(liveFeedMatch[1] ?? '');
    const since = Number.parseInt(url.searchParams.get('since') ?? '-1', 10);
    return sendJson(res, 200, await fetchLiveFeed(gameId, Number.isFinite(since) ? since : -1));
  }
  const jobMatch = /^\/api\/jobs\/([^/]+)\/(events|stop)$/.exec(pathname);
  if (jobMatch) {
    const id = decodeURIComponent(jobMatch[1] ?? '');
    if (jobMatch[2] === 'events' && method === 'GET') return attachJobEvents(id, res);
    if (jobMatch[2] === 'stop' && method === 'POST') return sendJson(res, 200, stopJob(id));
  }

  if (pathname === '/api/secrets' && method === 'GET') {
    return sendJson(res, 200, await secretStatus());
  }
  if (pathname === '/api/secrets' && method === 'POST') {
    const body = asRecord(await readBody(req));
    const name = String(body.name ?? '');
    const value = String(body.value ?? '');
    if (!isSecretName(name)) throw new HttpError(400, `unknown secret: ${name}`);
    if (!value) throw new HttpError(400, 'value required');
    await setSecret(name, value);
    return sendJson(res, 200, await secretStatus());
  }
  const secretMatch = /^\/api\/secrets\/([^/]+)$/.exec(pathname);
  if (secretMatch && method === 'DELETE') {
    const name = decodeURIComponent(secretMatch[1] ?? '');
    if (!isSecretName(name)) throw new HttpError(400, `unknown secret: ${name}`);
    await deleteSecret(name);
    return sendJson(res, 200, await secretStatus());
  }

  if (pathname === '/api/server/status' && method === 'GET') {
    const target = url.searchParams.get('target') ?? 'http://localhost:8787';
    return sendJson(res, 200, await gameServerStatus(target));
  }
  if (pathname === '/api/server/start' && method === 'POST') {
    return sendJson(res, 200, startGameServer());
  }
  if (pathname === '/api/server/stop' && method === 'POST') {
    return sendJson(res, 200, stopGameServer());
  }

  if (pathname.startsWith('/api/')) throw new HttpError(404, `no route: ${method} ${pathname}`);

  // Static: serve the built web UI when present; SPA-fallback to index.html.
  await serveStatic(res, pathname);
}

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

async function serveStatic(res: ServerResponse, pathname: string): Promise<void> {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.resolve(WEB_DIST, rel);
  if (!file.startsWith(WEB_DIST)) throw new HttpError(403, 'forbidden');
  try {
    const data = await fsp.readFile(file);
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    try {
      const index = await fsp.readFile(path.join(WEB_DIST, 'index.html'));
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(index);
    } catch {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(
        'Campaign Console API is running.\n\nNo built UI found — run `npm run build -w packages/harness-console`\nor use the Vite dev server: `npm run dev -w packages/harness-console`.\n',
      );
    }
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  route(req, res, url).catch((err: unknown) => {
    const status = err instanceof HttpError ? err.status : 500;
    const message = err instanceof Error ? err.message : String(err);
    if (!res.headersSent) sendJson(res, status, { error: message });
    else res.end();
  });
});

/** Best-effort warm-up so a viewer's first demo click doesn't eat the up to
 * 90s cold start. Never throws out of here — ensureGameServer() is still the
 * authority a demo run blocks on if this didn't finish (or failed) in time. */
async function bootGameServerCheck(): Promise<void> {
  try {
    if ((await gameServerStatus(DEMO_GAME_SERVER)).reachable) {
      console.log(`[console] game server already up at ${DEMO_GAME_SERVER}`);
      return;
    }
    startGameServer();
    console.log('[console] game server was down at boot — starting it now');
  } catch (err) {
    console.log(
      `[console] game server boot check failed, continuing without it: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Runs preflight once at boot and logs one line per non-ok check, so
 * environment drift (e.g. the PATH-lacks-claude bug this doctrine exists to
 * kill) shows up in the console's own log before anyone clicks a demo. */
async function logBootPreflight(): Promise<void> {
  const report = await runPreflight();
  for (const check of report.checks) {
    if (check.ok) continue;
    console.log(
      `[preflight] ${check.severity === 'fail' ? 'FAIL' : 'WARN'} ${check.label}: ${check.detail ?? '(no detail)'}`,
    );
  }
  if (report.ok) console.log('[preflight] all checks green');
}

server.listen(PORT, HOST, () => {
  console.log(`[console] Campaign Console on http://${HOST}:${PORT}`);
  console.log(`[console] scanning ${OUTPUT_DIR}`);
  void bootGameServerCheck().then(() => void logBootPreflight());
});
