#!/usr/bin/env tsx
/**
 * setup-bot-pool.ts — One-time bot pool setup for dev testing.
 *
 * Creates N persistent bot wallets, registers each with the game server,
 * faucets them MockUSDC on OP Sepolia (best-effort; skipped in mock mode),
 * and writes them to ~/.coordination/bot-pool.json.
 *
 * Idempotent: re-running tops the pool up to the target size without touching
 * existing bots.
 *
 * Usage:
 *   tsx scripts/setup-bot-pool.ts
 *   POOL_SIZE=12 tsx scripts/setup-bot-pool.ts
 *   GAME_SERVER=https://api.capturethelobster.com tsx scripts/setup-bot-pool.ts
 *
 * Env vars:
 *   GAME_SERVER — server URL (default: http://localhost:8787)
 *   POOL_SIZE   — target pool size (default: 8)
 */

import { ethers } from 'ethers';
import { authenticate, faucetBot, registerBotOnChain, loadPool, savePool, POOL_PATH, type PoolBot } from './lib/bot-agent.js';

const SERVER    = process.env.GAME_SERVER ?? 'http://localhost:8787';
const POOL_SIZE = parseInt(process.env.POOL_SIZE ?? '8');

const NAME_SUFFIX = process.env.BOT_NAME_SUFFIX ?? '';
const BOT_NAMES = [
  'bot-alice', 'bot-bob',   'bot-carol', 'bot-dave',
  'bot-erin',  'bot-frank', 'bot-grace', 'bot-henry',
  'bot-ivy',   'bot-jack',  'bot-kate',  'bot-liam',
].map(n => NAME_SUFFIX ? `${n}-${NAME_SUFFIX}` : n);

async function main() {
  console.log(`\nsetup-bot-pool — target size ${POOL_SIZE} on ${SERVER}\n`);

  const existing = await loadPool();
  console.log(`  Existing pool: ${existing.length} bot(s) in ${POOL_PATH}`);

  const toCreate = Math.max(0, POOL_SIZE - existing.length);
  if (toCreate === 0) {
    console.log(`  Pool already has ${existing.length} ≥ ${POOL_SIZE} — nothing to do.\n`);
    return;
  }

  console.log(`  Creating ${toCreate} new bot(s)...\n`);

  const used = new Set(existing.map(b => b.name));
  const fresh: PoolBot[] = [];
  let failures = 0;
  const MAX_FAILURES = 3;

  for (let i = 0; fresh.length < toCreate; i++) {
    if (failures >= MAX_FAILURES) {
      console.error(`\n  Aborting after ${failures} consecutive failure(s). Fix the error above and retry.\n`);
      break;
    }

    const name = BOT_NAMES[(existing.length + fresh.length) % BOT_NAMES.length]
      + (existing.length + fresh.length >= BOT_NAMES.length ? `-${i}` : '');
    if (used.has(name)) continue;

    const wallet = ethers.Wallet.createRandom();
    try {
      // 1. Faucet MockUSDC (no-op 503 in mock mode)
      const faucet = await faucetBot(SERVER, wallet.address);
      console.log(`  ${name} (${wallet.address.slice(0, 10)}...)`);
      console.log(`    faucet:   ${faucet ? 'minted 100 MockUSDC' : 'skipped (mock mode)'}`);

      // 2. On-chain register via relay (ERC-8004 mint + 5 USDC fee).
      //    In mock mode this still goes through MockRelay.register() harmlessly.
      const reg = await registerBotOnChain(SERVER, wallet.privateKey, wallet.address, name);
      console.log(`    register: ${reg.registered ? `agentId=${reg.agentId}` : 'already registered'}`);

      // 3. Sign auth challenge to confirm everything wired up.
      const { address, playerId } = await authenticate(SERVER, wallet.privateKey, name);
      console.log(`    auth:     playerId=${playerId.slice(0, 8)}...`);

      fresh.push({
        name,
        address,
        privateKey: wallet.privateKey,
        registeredAt: new Date().toISOString(),
        faucetedAt: faucet ? new Date().toISOString() : undefined,
      });
      used.add(name);
      failures = 0;
    } catch (err: any) {
      console.error(`  ${name} FAILED: ${err.message}`);
      used.add(name); // don't retry same name
      failures++;
    }
  }

  const final = [...existing, ...fresh];
  await savePool(final);
  console.log(`\nDone. Pool: ${final.length} bot(s) at ${POOL_PATH}\n`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
