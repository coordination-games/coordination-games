/**
 * GUI server — routes the local-only console. Loopback bind is enforced at
 * startup AND per request (Host header). All spec/artifact access goes through
 * the containment-checked ids in paths.ts; runs go through RunManager, which
 * only ever spawns the fixed harness CLI.
 */

import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { listArtifacts } from './artifacts.js';
import { assertLocalPost, createCsrfToken, GuardError } from './guard.js';
import {
  isLoopbackHost,
  readJsonBody,
  requestHostAllowed,
  requiredString,
  sendError,
  sendHtml,
  sendJson,
} from './http.js';
import { inspectArtifact, previewArtifactFile } from './inspect.js';
import { renderPage } from './page.js';
import { PathViolationError } from './paths.js';
import { RunManager } from './runs.js';
import { inspectSeries } from './series.js';
import { listSpecs, readSpecPreview, resolveSpec } from './specs.js';
import { summarizeSpec } from './summary.js';

const MAX_SSE_CLIENTS = 8;

export interface GuiServerOptions {
  host: string;
  port: number;
}

export interface GuiServer {
  server: Server;
  manager: RunManager;
  close(): Promise<void>;
}

function errorStatus(err: unknown): number {
  if (err instanceof PathViolationError) return 400;
  if (err instanceof GuardError) return err.status;
  const message = err instanceof Error ? err.message : '';
  if (message === 'no such run') return 404;
  if (message === 'request body too large') return 413;
  if (message.includes('already in progress') || message.includes('may run at once')) return 409;
  return 400;
}

export function startGuiServer(options: GuiServerOptions): Promise<GuiServer> {
  if (!isLoopbackHost(options.host)) {
    throw new Error(
      `refusing to bind non-loopback host "${options.host}" — this console is local-only`,
    );
  }
  const manager = new RunManager();
  const csrfToken = createCsrfToken();
  const sseClients = new Set<ServerResponse>();

  const server = createServer((req, res) => {
    void route(req, res).catch((err: unknown) => {
      if (!res.headersSent) sendError(res, 500, err);
      else res.end();
    });
  });

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!requestHostAllowed(req)) {
      sendError(res, 403, new Error('host not allowed — the console only answers loopback hosts'));
      return;
    }
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${options.port}`);
    const method = req.method ?? 'GET';
    try {
      if (method === 'GET' && url.pathname === '/') {
        const nonce = randomBytes(16).toString('base64');
        sendHtml(res, renderPage(nonce, csrfToken), nonce);
        return;
      }
      if (method === 'GET' && url.pathname === '/api/health') {
        sendJson(res, 200, { ok: true, service: 'coga-harness-gui' });
        return;
      }
      if (method === 'GET' && url.pathname === '/api/specs') {
        sendJson(res, 200, await listSpecs());
        return;
      }
      if (method === 'GET' && url.pathname === '/api/specs/preview') {
        sendJson(res, 200, await readSpecPreview(requiredParam(url, 'id')));
        return;
      }
      if (method === 'GET' && url.pathname === '/api/specs/summary') {
        sendJson(res, 200, await summarizeSpec(requiredParam(url, 'id')));
        return;
      }
      if (method === 'GET' && url.pathname === '/api/runs') {
        sendJson(res, 200, manager.list());
        return;
      }
      if (method === 'POST' && url.pathname === '/api/runs') {
        assertLocalPost(req, csrfToken);
        const body = await readJsonBody(req);
        const specId = requiredString(body, 'specId');
        const kind = body.kind === 'dry-run' ? 'dry-run' : 'run';
        const spec = await resolveSpec(specId);
        sendJson(res, 201, manager.start({ id: specId, name: spec.name, abs: spec.abs }, kind));
        return;
      }
      const runMatch = url.pathname.match(/^\/api\/runs\/([0-9a-f-]{36})(\/(?:stop|events))?$/);
      if (runMatch?.[1]) {
        const runId = runMatch[1];
        if (method === 'GET' && runMatch[2] === '/events') {
          attachEvents(res, runId);
          return;
        }
        if (method === 'POST' && runMatch[2] === '/stop') {
          assertLocalPost(req, csrfToken);
          await readJsonBody(req);
          sendJson(res, 200, manager.stop(runId));
          return;
        }
        if (method === 'GET' && !runMatch[2]) {
          sendJson(res, 200, { run: manager.get(runId), logs: manager.logsOf(runId) });
          return;
        }
      }
      if (method === 'GET' && url.pathname === '/api/artifacts') {
        sendJson(res, 200, await listArtifacts());
        return;
      }
      if (method === 'GET' && url.pathname === '/api/artifacts/inspect') {
        sendJson(res, 200, await inspectArtifact(requiredParam(url, 'id')));
        return;
      }
      if (method === 'GET' && url.pathname === '/api/artifacts/series') {
        sendJson(res, 200, await inspectSeries(requiredParam(url, 'id')));
        return;
      }
      if (method === 'GET' && url.pathname === '/api/artifacts/preview') {
        sendJson(
          res,
          200,
          await previewArtifactFile(requiredParam(url, 'id'), requiredParam(url, 'file')),
        );
        return;
      }
      sendJson(res, 404, { error: 'not found' });
    } catch (err) {
      sendError(res, errorStatus(err), err);
    }
  }

  function requiredParam(url: URL, key: string): string {
    const value = url.searchParams.get(key);
    if (!value) throw new Error(`query parameter "${key}" is required`);
    return value;
  }

  function attachEvents(res: ServerResponse, runId: string): void {
    if (sseClients.size >= MAX_SSE_CLIENTS) {
      sendError(res, 429, new Error('too many event streams open'));
      return;
    }
    let logs: ReturnType<RunManager['logsOf']>;
    let run: ReturnType<RunManager['get']>;
    try {
      run = manager.get(runId);
      logs = manager.logsOf(runId);
    } catch (err) {
      sendError(res, 404, err);
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Content-Type-Options': 'nosniff',
    });
    sseClients.add(res);
    const write = (event: string, payload: unknown): void => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    };
    // Replay retained logs BEFORE the status snapshot: the client closes the
    // EventSource on a terminal status, so status-first would drop the logs.
    for (const entry of logs) write('log', entry);
    write('status', run);
    const unsubscribe = manager.subscribe(runId, write);
    res.on('close', () => {
      unsubscribe();
      sseClients.delete(res);
    });
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      const shutdown = (): void => {
        manager.killAll();
        server.close();
      };
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
      resolve({
        server,
        manager,
        close: () =>
          new Promise<void>((done) => {
            manager.killAll();
            for (const client of sseClients) client.end();
            server.close(() => done());
          }),
      });
    });
  });
}
