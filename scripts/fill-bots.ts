#!/usr/bin/env tsx
/**
 * fill-bots.ts — Fill an existing lobby with Haiku bots from the pool.
 *
 * Designed for game-designer testing: you (or your agent) create and join a
 * lobby in the normal way, then run this script with the lobby ID to have
 * Haiku bots fill the remaining seats. Each bot gets its own `claude --print`
 * subprocess driving `coga serve --stdio` — same code path as any other player.
 *
 * Bots just call `get_guide`, read the rules, and use whatever per-name MCP
 * tools are exposed (e.g. propose_team / accept_team / choose_class / move).
 * No game-specific harness code.
 *
 * Prerequisites:
 *   - scripts/setup-bot-pool.ts has been run (creates ~/.coordination/bot-pool.json)
 *   - claude CLI installed and authenticated (~/.claude credentials)
 *   - wrangler dev running locally, OR GAME_SERVER pointing at prod
 *
 * Usage:
 *   tsx scripts/fill-bots.ts <lobbyId>                # fill all empty seats
 *   tsx scripts/fill-bots.ts <lobbyId> 3              # join exactly 3 bots
 *   GAME_SERVER=https://api.capturethelobster.com tsx scripts/fill-bots.ts <id>
 *
 * Env vars:
 *   GAME_SERVER — server URL (default: http://localhost:8787)
 *   MODEL       — claude model alias (default: haiku)
 */

import { api, authenticate, loadPool, runClaudeAgent, deriveCapacity, POOL_PATH } from './lib/bot-agent.js';

const SERVER = process.env.GAME_SERVER ?? 'http://localhost:8787';
const MODEL  = process.env.MODEL        ?? 'haiku';

async function main() {
  const lobbyId   = process.argv[2];
  const countArg  = process.argv[3];
  if (!lobbyId) {
    console.error('Usage: tsx scripts/fill-bots.ts <lobbyId> [count]');
    process.exit(1);
  }

  // 1. Load pool
  const pool = await loadPool();
  if (pool.length === 0) {
    console.error(`No bots in pool. Run: tsx scripts/setup-bot-pool.ts`);
    console.error(`Expected: ${POOL_PATH}`);
    process.exit(1);
  }
  console.log(`\nfill-bots — ${pool.length} bots available in pool, server ${SERVER}\n`);

  // 2. Fetch lobby state to figure out seats + gameType
  const lobbies = await api(SERVER, '/api/lobbies');
  const lobby = lobbies.find((l: any) => l.lobbyId === lobbyId);
  if (!lobby) {
    console.error(`Lobby ${lobbyId} not found. Is it still open? (not in phase='failed' or 'game')`);
    process.exit(1);
  }

  const capacity  = deriveCapacity(lobby.gameType, lobby.teamSize);
  const occupied  = lobby.playerCount ?? 0;
  const remaining = capacity - occupied;
  console.log(`  Lobby ${lobbyId.slice(0, 8)} — ${lobby.gameType}, ${occupied}/${capacity} seats filled`);

  if (remaining <= 0) {
    console.log('  Lobby already full. Nothing to do.\n');
    return;
  }

  const wanted = countArg ? Math.min(parseInt(countArg), remaining) : remaining;
  if (wanted > pool.length) {
    console.error(`  Need ${wanted} bots but pool only has ${pool.length}. Run setup-bot-pool with POOL_SIZE=${wanted}.`);
    process.exit(1);
  }

  // 3. Pick bots (simple: first N from pool). Check who's already in the lobby
  //    by looking at the lobby state agents list, so we don't try to join twice.
  const lobbyState: any = await api(SERVER, `/api/lobbies/${lobbyId}/state`).catch(() => null);
  const alreadyIn = new Set<string>(
    (lobbyState?.agents ?? []).map((a: any) => String(a.handle).toLowerCase()),
  );

  const picked = pool.filter(b => !alreadyIn.has(b.name.toLowerCase())).slice(0, wanted);
  if (picked.length < wanted) {
    console.error(`  Only ${picked.length} pool bots are not already in this lobby.`);
    process.exit(1);
  }

  // 4. Auth + join each bot
  console.log(`  Joining ${picked.length} bot(s) into lobby...`);
  const live: { name: string; token: string; playerId: string; privateKey: string }[] = [];
  for (const bot of picked) {
    try {
      const { token, playerId } = await authenticate(SERVER, bot.privateKey, bot.name);
      await api(SERVER, '/api/player/lobby/join', {
        method: 'POST', token,
        body: { lobbyId },
      });
      console.log(`    ${bot.name} joined (${playerId.slice(0, 8)}...)`);
      live.push({ name: bot.name, token, playerId, privateKey: bot.privateKey });
    } catch (err: any) {
      console.error(`    ${bot.name} FAILED to join: ${err.message}`);
    }
  }

  if (live.length === 0) {
    console.error('No bots joined. Aborting.');
    process.exit(1);
  }

  // 5. Spawn Claude agents for each bot. They read get_guide and drive
  //    the rest of the flow themselves — lobby phases, game, the works.
  console.log(`\nSpawning ${live.length} Claude agent(s) with model=${MODEL}...\n`);
  await Promise.all(live.map(b => runClaudeAgent({
    server:     SERVER,
    botName:    b.name,
    privateKey: b.privateKey,
    gameType:   lobby.gameType,
    model:      MODEL,
  })));

  console.log('\nAll bots finished.\n');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
