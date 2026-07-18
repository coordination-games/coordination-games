import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type GuiServer, startGuiServer } from '../server.js';

/**
 * POST hardening: mutating routes must reject cross-site browser requests
 * (Origin/Referer), non-JSON content types, missing/forged CSRF tokens, and
 * oversized bodies — while legitimate local console operations keep working.
 */

let gui: GuiServer;
let base: string;
let csrf: string;

beforeAll(async () => {
  gui = await startGuiServer({ host: '127.0.0.1', port: 0 });
  const { port } = gui.server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
  const html = await (await fetch(`${base}/`)).text();
  const match = html.match(/name="harness-csrf" content="([^"]+)"/);
  if (!match?.[1]) throw new Error('csrf meta tag missing from the console page');
  csrf = match[1];
});

afterAll(async () => {
  await gui.close();
});

function post(pathname: string, body: unknown, headers: Record<string, string>): Promise<Response> {
  return fetch(`${base}${pathname}`, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const JSON_CT = { 'Content-Type': 'application/json' };

describe('POST /api/runs — cross-site and content-type hardening', () => {
  it('rejects a non-loopback Origin with 403 even when everything else is valid', async () => {
    // Given a forged cross-site browser request / When posted / Then the guard rejects it
    const res = await post(
      '/api/runs',
      { specId: 'runs:claude-totc.yaml', kind: 'dry-run' },
      { ...JSON_CT, 'x-harness-csrf': csrf, Origin: 'https://evil.example' },
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/origin/i);
  });

  it('rejects a non-loopback Referer with 403', async () => {
    const res = await post(
      '/api/runs',
      { specId: 'runs:claude-totc.yaml', kind: 'dry-run' },
      { ...JSON_CT, 'x-harness-csrf': csrf, Referer: 'https://evil.example/page' },
    );
    expect(res.status).toBe(403);
  });

  it('rejects a text/plain content type with 415', async () => {
    // text/plain POSTs can be sent cross-site without a CORS preflight
    const res = await post(
      '/api/runs',
      JSON.stringify({ specId: 'runs:claude-totc.yaml', kind: 'dry-run' }),
      { 'Content-Type': 'text/plain', 'x-harness-csrf': csrf },
    );
    expect(res.status).toBe(415);
  });

  it('rejects a missing CSRF token with 403', async () => {
    const res = await post(
      '/api/runs',
      { specId: 'runs:claude-totc.yaml', kind: 'dry-run' },
      JSON_CT,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/csrf/i);
  });

  it('rejects a forged CSRF token with 403', async () => {
    const res = await post(
      '/api/runs',
      { specId: 'runs:claude-totc.yaml', kind: 'dry-run' },
      { ...JSON_CT, 'x-harness-csrf': 'f'.repeat(64) },
    );
    expect(res.status).toBe(403);
  });

  it('rejects a body over the 64 KiB cap with 413', async () => {
    const res = await post(
      '/api/runs',
      { specId: 'runs:claude-totc.yaml', kind: 'dry-run', pad: 'x'.repeat(70 * 1024) },
      { ...JSON_CT, 'x-harness-csrf': csrf },
    );
    expect(res.status).toBe(413);
  });

  it('rejects a traversal spec id with 400 after passing the guard', async () => {
    const res = await post(
      '/api/runs',
      { specId: 'runs:../secrets.yaml', kind: 'dry-run' },
      { ...JSON_CT, 'x-harness-csrf': csrf },
    );
    expect(res.status).toBe(400);
  });

  it('accepts a legitimate local POST carrying the session CSRF token', async () => {
    // Given the console's own token / When a dry-run is started / Then it is created
    const res = await post(
      '/api/runs',
      { specId: 'runs:claude-totc.yaml', kind: 'dry-run' },
      { ...JSON_CT, 'x-harness-csrf': csrf },
    );
    expect(res.status).toBe(201);
    const run = (await res.json()) as { id: string };

    // Stop it through the guarded stop route with full browser-style headers.
    const stopped = await post(
      `/api/runs/${run.id}/stop`,
      {},
      {
        ...JSON_CT,
        'x-harness-csrf': csrf,
        Origin: base,
        Referer: `${base}/`,
      },
    );
    expect(stopped.status).toBe(200);

    // Drain to a terminal state so no child outlives the test.
    const deadline = Date.now() + 20_000;
    let status = 'running';
    while (status === 'running') {
      if (Date.now() > deadline) throw new Error('run did not reach a terminal state');
      await new Promise((r) => setTimeout(r, 250));
      const snap = (await (await fetch(`${base}/api/runs/${run.id}`)).json()) as {
        run: { status: string };
      };
      status = snap.run.status;
    }
    expect(['stopped', 'completed', 'failed']).toContain(status);
  }, 30_000);

  it('guards the stop route: missing CSRF token is rejected with 403', async () => {
    const res = await post(
      `/api/runs/${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}/stop`,
      {},
      JSON_CT,
    );
    expect(res.status).toBe(403);
  });
});

describe('POST /api/runs/:id/stop — universal body cap', () => {
  it('rejects an oversized stop body with 413 before acting on the run', async () => {
    // Given a >64KiB body on the stop route / When posted with a valid token / Then the cap fires
    const res = await post(
      `/api/runs/${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}/stop`,
      { pad: 'x'.repeat(70 * 1024) },
      { ...JSON_CT, 'x-harness-csrf': csrf },
    );
    expect(res.status).toBe(413);
  });
});
