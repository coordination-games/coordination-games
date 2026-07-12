import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type GuiServer, startGuiServer } from '../server.js';

/**
 * HTTP-level regression for the SSE initial replay: the browser client closes
 * its EventSource as soon as it sees a terminal status, so for a finished run
 * every retained log event MUST be written before the status snapshot. This
 * drives the real server + the real harness CLI (dry-run, no network needed).
 */

let gui: GuiServer;
let base: string;

beforeAll(async () => {
  gui = await startGuiServer({ host: '127.0.0.1', port: 0 });
  const { port } = gui.server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await gui.close();
});

interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}

/** Read the SSE stream until a terminal status event, then abort. */
async function readUntilTerminalStatus(url: string): Promise<SseEvent[]> {
  const controller = new AbortController();
  const res = await fetch(url, { signal: controller.signal });
  expect(res.ok).toBe(true);
  const reader = res.body?.getReader();
  if (!reader) throw new Error('no response body');
  const decoder = new TextDecoder();
  const events: SseEvent[] = [];
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let split = buffer.indexOf('\n\n');
    while (split !== -1) {
      const frame = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      const eventLine = frame.match(/^event: (.+)$/m);
      const dataLine = frame.match(/^data: (.+)$/m);
      if (eventLine?.[1] && dataLine?.[1]) {
        const parsed = {
          event: eventLine[1],
          data: JSON.parse(dataLine[1]) as Record<string, unknown>,
        };
        events.push(parsed);
        if (parsed.event === 'status' && parsed.data.status !== 'running') {
          controller.abort();
          return events;
        }
      }
      split = buffer.indexOf('\n\n');
    }
  }
  return events;
}

describe('GET /api/runs/:id/events — initial replay ordering', () => {
  it('delivers every retained log before the terminal status for a completed run', async () => {
    // Given a dry-run driven through the real CLI to completion
    const started = await fetch(`${base}/api/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ specId: 'runs:claude-totc.yaml', kind: 'dry-run' }),
    });
    expect(started.status).toBe(201);
    const run = (await started.json()) as { id: string };

    const deadline = Date.now() + 20_000;
    let status = 'running';
    let logCount = 0;
    while (status === 'running') {
      if (Date.now() > deadline) throw new Error('dry-run did not finish in time');
      await new Promise((r) => setTimeout(r, 250));
      const snap = (await (await fetch(`${base}/api/runs/${run.id}`)).json()) as {
        run: { status: string; logCount: number };
      };
      status = snap.run.status;
      logCount = snap.run.logCount;
    }
    expect(status).toBe('completed');
    expect(logCount).toBeGreaterThan(0);

    // When a client attaches to the finished run's event stream
    const events = await readUntilTerminalStatus(`${base}/api/runs/${run.id}/events`);

    // Then the full retained log backlog precedes the terminal status event
    const statusIdx = events.findIndex((e) => e.event === 'status');
    const logEvents = events.filter((e) => e.event === 'log');
    expect(logEvents.length).toBe(logCount);
    expect(statusIdx).toBe(events.length - 1);
    expect(events[statusIdx]?.data.status).toBe('completed');
  }, 30_000);
});
