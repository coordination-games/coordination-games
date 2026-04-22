#!/usr/bin/env tsx
/**
 * run-game.ts — End-to-end multi-bot game runner.
 *
 * Spawns N ephemeral bot wallets, creates a lobby, joins everyone, then hands
 * off to `claude --print` per bot. Bots drive everything — lobby phases (team
 * formation, class selection) and gameplay — through the unified per-name MCP
 * tool surface (propose_team, accept_team, choose_class, move, propose_pledge,
 * submit_decision, chat, etc.) discovered via get_state.currentPhase.tools.
 *
 * For filling an existing lobby with persistent pool bots, use:
 *   tsx scripts/fill-bots.ts <lobbyId>
 *
 * Usage:
 *   tsx scripts/run-game.ts
 *   GAME_TYPE=capture-the-lobster TEAM_SIZE=2 tsx scripts/run-game.ts
 *   GAME_TYPE=oathbreaker BOT_COUNT=6 tsx scripts/run-game.ts
 *   GAME_SERVER=https://api.games.coop tsx scripts/run-game.ts
 *
 * Env vars:
 *   GAME_SERVER  — server URL (default: http://localhost:8787)
 *   GAME_TYPE    — game type slug (default: oathbreaker)
 *   BOT_COUNT    — total bots (default: 4 for oathbreaker, TEAM_SIZE*2 for ctl)
 *   TEAM_SIZE    — players per team for team-based games (default: 2)
 *   MODEL        — claude model alias passed to --model (default: haiku)
 *
 * Prerequisites:
 *   wrangler dev running in packages/workers-server/ (or GAME_SERVER → prod)
 *   claude CLI installed and authenticated (~/.claude credentials)
 */

import { ethers } from 'ethers';
import { api, authenticate, runClaudeAgent } from './lib/bot-agent.js';

const SERVER = process.env.GAME_SERVER ?? 'http://localhost:8787';
const GAME_TYPE = process.env.GAME_TYPE ?? 'oathbreaker';
const TEAM_SIZE = parseInt(process.env.TEAM_SIZE ?? '2', 10);
const BOT_COUNT = parseInt(
  process.env.BOT_COUNT ?? (GAME_TYPE === 'oathbreaker' ? '4' : String(TEAM_SIZE * 2)),
  10,
);
const MODEL = process.env.MODEL ?? 'haiku';

async function main() {
  console.log(`\nrun-game — ${BOT_COUNT} bots playing ${GAME_TYPE} on ${SERVER}\n`);

  // 1. Create ephemeral wallets and authenticate
  console.log('Creating wallets and authenticating...');
  const bots: { name: string; token: string; playerId: string; privateKey: string }[] = [];

  for (let i = 0; i < BOT_COUNT; i++) {
    const wallet = ethers.Wallet.createRandom();
    const name = `bot${i + 1}-${wallet.address.slice(2, 8)}`;
    const { token, playerId } = await authenticate(SERVER, wallet.privateKey, name);
    bots.push({ name, token, playerId, privateKey: wallet.privateKey });
    console.log(`  ${name} authenticated (${playerId.slice(0, 8)}...)`);
  }

  // 2. Create lobby
  console.log(`\nCreating ${GAME_TYPE} lobby...`);
  const lobbyBody =
    GAME_TYPE === 'oathbreaker'
      ? { gameType: GAME_TYPE, teamSize: BOT_COUNT }
      : { gameType: GAME_TYPE, teamSize: TEAM_SIZE };
  const lobby = await api(SERVER, '/api/lobbies/create', {
    method: 'POST',
    body: lobbyBody,
    token: bots[0].token,
  });
  console.log(`  Lobby: ${lobby.lobbyId}`);

  // 3. Join all bots
  console.log('Joining lobby...');
  for (const bot of bots) {
    const res = await api(SERVER, '/api/player/lobby/join', {
      method: 'POST',
      token: bot.token,
      body: { lobbyId: lobby.lobbyId },
    });
    console.log(`  ${bot.name} joined (phase: ${res.phase})`);
  }

  // 4. Hand off to Claude agents — they drive lobby phases + game via MCP tools
  console.log('\nAll bots playing...\n');
  await Promise.all(
    bots.map((b) =>
      runClaudeAgent({
        server: SERVER,
        botName: b.name,
        privateKey: b.privateKey,
        gameType: GAME_TYPE,
        model: MODEL,
      }),
    ),
  );

  console.log('\nDone.\n');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
