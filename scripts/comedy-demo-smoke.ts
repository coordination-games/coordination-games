#!/usr/bin/env tsx

import { Wallet } from 'ethers';
import { api, authenticate } from './lib/bot-agent.js';

interface SmokeOptions {
  server: string;
  playerCount: number;
  namePrefix: string;
  maxWaitMs: number;
}

function parseArgs(): SmokeOptions {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };

  return {
    server: get('--server-url') ?? process.env.GAME_SERVER ?? 'http://localhost:8787',
    playerCount: Number(get('--count') ?? process.env.BOT_COUNT ?? '4'),
    namePrefix: get('--name-prefix') ?? 'Smoke',
    maxWaitMs: Number(get('--max-wait-ms') ?? '10000'),
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForReplay(server: string, gameId: string, maxWaitMs: number) {
  const started = Date.now();
  while (Date.now() - started < maxWaitMs) {
    try {
      const replay = await api(server, `/api/games/${gameId}/replay`);
      if (Array.isArray(replay.snapshots) && replay.snapshots.length > 0) {
        return replay;
      }
    } catch {
      // wait and retry
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for replay for game ${gameId}`);
}

async function main() {
  const { server, playerCount, namePrefix, maxWaitMs } = parseArgs();
  if (playerCount < 4) {
    throw new Error('Comedy demo smoke requires at least 4 players');
  }

  console.log(`\ncomedy-demo-smoke — ${playerCount} players on ${server}\n`);

  const players: Array<{ name: string; token: string; playerId: string; address: string }> = [];

  for (let i = 0; i < playerCount; i++) {
    const wallet = Wallet.createRandom();
    const name = `${namePrefix}${i + 1}`;
    const auth = await authenticate(server, wallet.privateKey, name);
    players.push({ ...auth, name, address: wallet.address });
    console.log(`  authenticated ${name} (${auth.playerId.slice(0, 8)}...)`);
  }

  const created = await api(server, '/api/lobbies/create', {
    method: 'POST',
    token: players[0].token,
    body: { gameType: 'comedy-of-the-commons', teamSize: playerCount },
  });
  const lobbyId = created.lobbyId as string;
  console.log(`\n  lobby: ${lobbyId}`);

  let gameId: string | null = null;
  for (const player of players) {
    const joined = await api(server, '/api/player/lobby/join', {
      method: 'POST',
      token: player.token,
      body: { lobbyId },
    });
    console.log(`  ${player.name} joined (phase: ${joined.phase ?? joined.currentPhase?.id ?? 'unknown'})`);
    if (joined.gameId) gameId = joined.gameId;
  }

  if (!gameId) {
    throw new Error('Lobby did not promote into a game');
  }

  const games = await api(server, '/api/games');
  const game = Array.isArray(games) ? games.find((entry) => entry.id === gameId) : null;
  const spectator = await api(server, `/api/games/${gameId}/spectator`);
  const replay = await waitForReplay(server, gameId, maxWaitMs);
  const replayUrl = `http://127.0.0.1:4177/replay/${gameId}`;

  console.log('\nSmoke summary');
  console.log(JSON.stringify({
    lobbyId,
    gameId,
    playerCount,
    gameSummary: game,
    spectatorType: spectator.type,
    replaySnapshots: replay.snapshots?.length ?? 0,
    replayUrl,
  }, null, 2));
}

main().catch((err) => {
  console.error('\nFatal comedy-demo-smoke error:\n', err);
  process.exit(1);
});
