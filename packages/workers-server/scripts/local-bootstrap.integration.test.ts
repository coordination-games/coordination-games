import { mkdtemp, rm } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, describe, expect, it } from 'vitest';
import { deriveMockChainAgentId } from '../src/chain/mock-relay.js';
import {
  executeLocalD1,
  hasAuthNoncesTable,
  startLocalBootstrap,
  startUnmigratedLocalWorker,
} from './local-bootstrap-runtime.js';

const repositoryRoot = resolve(import.meta.dirname, '../../..');
const configPath = resolve(import.meta.dirname, '../wrangler.toml');
const port = 8997;

async function waitForHealth(url: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Worker did not become ready at ${url}`);
}

function portIsOpen(port: number): Promise<boolean> {
  return new Promise((resolveOpen) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolveOpen(true);
    });
    socket.once('error', () => resolveOpen(false));
  });
}

async function waitForPortClosed(port: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!(await portIsOpen(port))) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`Port ${port} remained open after worker stop`);
}

describe('local bootstrap integration', () => {
  let persistenceDirectory: string | undefined;
  let stop: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (stop) await stop();
    if (persistenceDirectory) await rm(persistenceDirectory, { recursive: true, force: true });
    stop = undefined;
    persistenceDirectory = undefined;
  });

  it('starts an unmigrated isolated worker whose auth challenge exposes the missing auth_nonces table', async () => {
    persistenceDirectory = await mkdtemp(resolve(tmpdir(), 'coga-bootstrap-unmigrated-'));
    const unmigrated = await startUnmigratedLocalWorker(
      { persistTo: persistenceDirectory, port: 8996 },
      repositoryRoot,
      configPath,
    );
    stop = unmigrated.stop;
    await waitForHealth('http://127.0.0.1:8996/health');

    const challenge = await fetch('http://127.0.0.1:8996/api/player/auth/challenge', {
      method: 'POST',
    });
    expect(challenge.ok).toBe(false);
    expect(challenge.status).toBe(500);
    expect(await challenge.text()).toMatch(/no such table: auth_nonces/i);
    await stop();
    stop = undefined;
    await waitForPortClosed(8996);
  }, 30_000);

  it('migrates isolated D1 state idempotently and completes EIP-191 auth with replay rejection', async () => {
    persistenceDirectory = await mkdtemp(resolve(tmpdir(), 'coga-bootstrap-integration-'));
    const first = await startLocalBootstrap(
      { persistTo: persistenceDirectory, port },
      repositoryRoot,
      configPath,
    );
    stop = first.stop;
    await waitForHealth(`http://127.0.0.1:${port}/health`);
    expect(
      await hasAuthNoncesTable(
        { persistTo: persistenceDirectory, port },
        repositoryRoot,
        configPath,
      ),
    ).toBe(true);
    const treasury = await executeLocalD1(
      { persistTo: persistenceDirectory, port },
      repositoryRoot,
      configPath,
      "SELECT p.chain_agent_id, (SELECT COUNT(*) FROM player_sessions WHERE player_id = p.id) AS sessions FROM players p WHERE p.handle = 'local-tournament-treasury'",
    );
    expect(treasury).toContain('2147483647');
    expect(treasury).toMatch(/"sessions"\s*:\s*0/);
    await executeLocalD1(
      { persistTo: persistenceDirectory, port },
      repositoryRoot,
      configPath,
      "INSERT INTO player_sessions (player_id, lobby_id, joined_at) VALUES ('terminal-proof', 'terminal-lobby', '2026-01-01T00:00:00Z')",
    );
    await expect(
      executeLocalD1(
        { persistTo: persistenceDirectory, port },
        repositoryRoot,
        configPath,
        "UPDATE player_sessions SET terminal_state = 'completed' WHERE player_id = 'terminal-proof'",
      ),
    ).resolves.toContain('success');
    await expect(
      executeLocalD1(
        { persistTo: persistenceDirectory, port },
        repositoryRoot,
        configPath,
        "UPDATE player_sessions SET terminal_state = 'invalid' WHERE player_id = 'terminal-proof'",
      ),
    ).rejects.toThrow(/CHECK constraint failed/i);

    const challenge = await fetch(`http://127.0.0.1:${port}/api/player/auth/challenge`, {
      method: 'POST',
    });
    expect(challenge.status).toBe(200);
    const challengeBody = (await challenge.json()) as {
      nonce: string;
      message: string;
      expiresAt: string;
    };
    expect(challengeBody.nonce).not.toHaveLength(0);
    expect(challengeBody.message).toContain(challengeBody.nonce);
    expect(Number.isNaN(Date.parse(challengeBody.expiresAt))).toBe(false);

    const account = privateKeyToAccount(generatePrivateKey());
    const signature = await account.signMessage({ message: challengeBody.message });
    const verificationPayload = {
      nonce: challengeBody.nonce,
      signature,
      address: account.address,
      name: 'bootstrap-integration',
    };
    const verified = await fetch(`http://127.0.0.1:${port}/api/player/auth/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(verificationPayload),
    });
    expect(verified.status).toBe(200);
    const verifiedBody = (await verified.json()) as { token: string; agentId: string };
    expect(verifiedBody.token).not.toHaveLength(0);
    expect(verifiedBody.agentId).not.toHaveLength(0);
    const registeredPlayer = await executeLocalD1(
      { persistTo: persistenceDirectory, port },
      repositoryRoot,
      configPath,
      `SELECT chain_agent_id FROM players WHERE id = '${verifiedBody.agentId}'`,
    );
    expect(registeredPlayer).toContain(String(deriveMockChainAgentId(account.address)));

    const reconnectChallenge = await fetch(`http://127.0.0.1:${port}/api/player/auth/challenge`, {
      method: 'POST',
    });
    const reconnectBody = (await reconnectChallenge.json()) as { nonce: string; message: string };
    const reconnectSignature = await account.signMessage({ message: reconnectBody.message });
    const reconnected = await fetch(`http://127.0.0.1:${port}/api/player/auth/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        nonce: reconnectBody.nonce,
        signature: reconnectSignature,
        address: account.address,
        name: 'bootstrap-integration',
      }),
    });
    expect(reconnected.status).toBe(200);

    const replay = await fetch(`http://127.0.0.1:${port}/api/player/auth/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(verificationPayload),
    });
    expect(replay.status).toBe(401);

    await stop();
    stop = undefined;
    const second = await startLocalBootstrap(
      { persistTo: persistenceDirectory, port },
      repositoryRoot,
      configPath,
    );
    stop = second.stop;
    expect(second.migrationOutput).toMatch(/no migrations to apply/i);
    const secondTreasury = await executeLocalD1(
      { persistTo: persistenceDirectory, port },
      repositoryRoot,
      configPath,
      "SELECT COUNT(*) AS count FROM players WHERE handle = 'local-tournament-treasury'",
    );
    expect(secondTreasury).toMatch(/"count"\s*:\s*1/);
    await stop();
    stop = undefined;
    await waitForPortClosed(port);
  }, 60_000);

  it('accepts the canonical three-player Tragedy tournament lobby before player authentication', async () => {
    persistenceDirectory = await mkdtemp(resolve(tmpdir(), 'coga-bootstrap-three-player-'));
    const bootstrap = await startLocalBootstrap(
      { persistTo: persistenceDirectory, port: 8995 },
      repositoryRoot,
      configPath,
    );
    stop = bootstrap.stop;
    await waitForHealth('http://127.0.0.1:8995/health');

    const created = await fetch('http://127.0.0.1:8995/api/lobbies/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        gameType: 'tragedy-of-the-commons',
        teamSize: 3,
        tournament: {
          mode: 'tragedy-series',
          policy: {
            seriesLength: 3,
            baseEntryCost: '100',
            carryBps: 1500,
            slashBps: 500,
            minRounds: 2,
            maxRounds: 8,
            hazardNumerator: 1,
            hazardDenominator: 4,
          },
        },
      }),
    });

    const body = await created.text();
    expect(created.status, body).toBe(201);
  }, 30_000);

  it('keeps chain identity null when strict-local settlement is disabled', async () => {
    persistenceDirectory = await mkdtemp(resolve(tmpdir(), 'coga-bootstrap-strict-off-'));
    const bootstrap = await startLocalBootstrap(
      { persistTo: persistenceDirectory, port: 8998, strictLocalSettlement: false },
      repositoryRoot,
      configPath,
    );
    stop = bootstrap.stop;
    await waitForHealth('http://127.0.0.1:8998/health');
    const account = privateKeyToAccount(generatePrivateKey());
    const challenge = await fetch('http://127.0.0.1:8998/api/player/auth/challenge', {
      method: 'POST',
    });
    const challengeBody = (await challenge.json()) as { nonce: string; message: string };
    const signature = await account.signMessage({ message: challengeBody.message });
    const verified = await fetch('http://127.0.0.1:8998/api/player/auth/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        nonce: challengeBody.nonce,
        signature,
        address: account.address,
        name: 'strict-off-auth',
      }),
    });
    const verifiedBody = (await verified.json()) as { agentId: string };
    expect(verified.status).toBe(200);
    const player = await executeLocalD1(
      { persistTo: persistenceDirectory, port: 8998, strictLocalSettlement: false },
      repositoryRoot,
      configPath,
      `SELECT chain_agent_id FROM players WHERE id = '${verifiedBody.agentId}'`,
    );
    expect(player).toMatch(/"chain_agent_id"\s*:\s*null/);
  }, 30_000);
});
