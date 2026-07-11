#!/usr/bin/env tsx

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ethers } from 'ethers';
import { api, authenticate, faucetBot, registerBotOnChain } from './lib/bot-agent.js';
import {
  ensureTreasuryRegistration,
  parseTreasurySeedStatus,
  type TreasurySeedStatus,
} from './lib/treasury-seed-flow.js';

const TREASURY_DIR = path.join(os.homedir(), '.coordination');
const TREASURY_PATH = path.join(TREASURY_DIR, 'tournament-treasury.json');

type TreasurySeed = TreasurySeedStatus & {
  readonly privateKey: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function printHelp(): void {
  console.log(`Usage: TREASURY_AGENT_HANDLE=<handle> tsx scripts/seed-treasury.ts [--dry-run]

Creates or reuses a registered non-playing treasury identity for settlement.

Environment:
  TREASURY_AGENT_HANDLE  Required D1/chain handle for the treasury identity.
  GAME_SERVER             Server URL (default: http://localhost:8787).

Options:
  --dry-run               Print the configured safe surface without creating a wallet or calling the server.
  --help                  Show this help.

The private key is written only to ~/.coordination/tournament-treasury.json and is never printed.`);
}

function isTreasurySeed(value: unknown): value is TreasurySeed {
  if (!isRecord(value) || parseTreasurySeedStatus(value) === null) return false;
  return (
    typeof value.handle === 'string' &&
    typeof value.server === 'string' &&
    typeof value.address === 'string' &&
    typeof value.privateKey === 'string' &&
    typeof value.createdAt === 'string'
  );
}

function isRegistrationStatus(value: unknown): value is { readonly registered: boolean } {
  return isRecord(value) && typeof value.registered === 'boolean';
}

async function loadTreasury(): Promise<TreasurySeed | null> {
  let raw: string;
  try {
    raw = await fs.readFile(TREASURY_PATH, 'utf8');
  } catch (error) {
    if (error instanceof Error && error.message.includes('ENOENT')) return null;
    throw error;
  }
  const parsed: unknown = JSON.parse(raw);
  if (!isTreasurySeed(parsed)) {
    throw new Error(`Invalid treasury seed shape at ${TREASURY_PATH}`);
  }
  return parsed;
}

async function saveTreasury(seed: TreasurySeed): Promise<void> {
  await fs.mkdir(TREASURY_DIR, { recursive: true });
  await fs.writeFile(TREASURY_PATH, `${JSON.stringify(seed, null, 2)}\n`, { mode: 0o600 });
}

function readConfiguration(): {
  readonly handle: string;
  readonly server: string;
  readonly dryRun: boolean;
} {
  const args = new Set(process.argv.slice(2));
  if (args.has('--help')) {
    printHelp();
    process.exit(0);
  }
  for (const arg of args) {
    if (arg !== '--dry-run') throw new Error(`Unknown option: ${arg}`);
  }
  const handle = process.env.TREASURY_AGENT_HANDLE;
  if (handle === undefined || handle.trim().length === 0) {
    throw new Error('TREASURY_AGENT_HANDLE is required and must not be empty');
  }
  return {
    handle,
    server: process.env.GAME_SERVER ?? 'http://localhost:8787',
    dryRun: args.has('--dry-run'),
  };
}

async function main(): Promise<void> {
  const config = readConfiguration();
  if (config.dryRun) {
    console.log(`seed-treasury dry run: handle=${config.handle} server=${config.server}`);
    return;
  }

  const existing = await loadTreasury();
  if (
    existing !== null &&
    (existing.handle !== config.handle || existing.server !== config.server)
  ) {
    throw new Error(
      `Existing treasury seed is for handle=${existing.handle} server=${existing.server}; refusing to overwrite`,
    );
  }

  const seed =
    existing ??
    (() => {
      const wallet = ethers.Wallet.createRandom();
      return {
        handle: config.handle,
        server: config.server,
        address: wallet.address,
        privateKey: wallet.privateKey,
        createdAt: new Date().toISOString(),
      };
    })();

  if (existing === null) await saveTreasury(seed);

  let authenticatedPlayerId = '';
  const completed = await ensureTreasuryRegistration(seed, {
    faucet: async () => {
      await faucetBot(config.server, seed.address);
    },
    register: async () => {
      await registerBotOnChain(config.server, seed.privateKey, seed.address, config.handle);
    },
    registrationReady: async () => {
      const status: unknown = await api(config.server, `/api/relay/status/${seed.address}`);
      if (!isRegistrationStatus(status))
        throw new Error('Invalid relay registration status response');
      return status.registered;
    },
    authenticate: async () => {
      const authenticated = await authenticate(config.server, seed.privateKey, config.handle);
      authenticatedPlayerId = authenticated.playerId;
    },
    persist: async (status) => {
      await saveTreasury({ ...seed, ...status });
    },
    now: () => new Date().toISOString(),
  });
  console.log(
    `Treasury ready: handle=${completed.handle} playerId=${authenticatedPlayerId.slice(0, 8)}... registration=complete faucet=complete`,
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`seed-treasury failed: ${message}`);
  process.exit(1);
});
