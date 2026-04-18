#!/usr/bin/env tsx

import { Wallet } from 'ethers';
import { promises as fs } from 'fs';
import { api, authenticate } from './lib/bot-agent.js';

interface SmokeOptions {
  server: string;
  webBaseUrl: string;
  playerCount: number;
  namePrefix: string;
  maxWaitMs: number;
  resumeDelayMs: number;
  finishWaitMs: number;
  workerLogPath?: string;
  directGameCreate: boolean;
}

function parseArgs(): SmokeOptions {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };

  return {
    server: get('--server-url') ?? process.env.GAME_SERVER ?? 'http://localhost:8787',
    webBaseUrl: get('--web-base-url') ?? process.env.WEB_BASE_URL ?? 'http://127.0.0.1:4173',
    playerCount: Number(get('--count') ?? process.env.BOT_COUNT ?? '4'),
    namePrefix: get('--name-prefix') ?? 'Smoke',
    maxWaitMs: Number(get('--max-wait-ms') ?? '10000'),
    resumeDelayMs: Number(get('--resume-delay-ms') ?? '1500'),
    finishWaitMs: Number(get('--finish-wait-ms') ?? '0'),
    workerLogPath: get('--worker-log-path') ?? process.env.WORKER_LOG_PATH,
    directGameCreate: (get('--direct-game-create') ?? process.env.DIRECT_GAME_CREATE ?? '').toLowerCase() === 'true',
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function authenticateWithRetry(server: string, privateKey: string, baseName: string, attempts = 4) {
  let lastError: unknown;
  let currentName = baseName;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const auth = await authenticate(server, privateKey, currentName);
      return { ...auth, name: currentName };
    } catch (error) {
      lastError = error;
      const message = String(error instanceof Error ? error.message : error);
      if (/already taken|409/i.test(message)) {
        currentName = `${baseName}-${Date.now().toString(36).slice(-4)}-${attempt + 1}`;
        continue;
      }
      if (!/worker restarted mid-request|503/i.test(message) || attempt === attempts - 1) {
        throw error;
      }
      await sleep(500 * (attempt + 1));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
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

async function waitForGameFinished(server: string, gameId: string, maxWaitMs: number) {
  const started = Date.now();
  while (Date.now() - started < maxWaitMs) {
    try {
      const game = await api(server, `/api/games/${gameId}`);
      if (game?.finished || game?.phase === 'finished') {
        return game;
      }
    } catch {
      // wait and retry
    }
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for game ${gameId} to finish`);
}

async function readLogOffset(path?: string): Promise<number | null> {
  if (!path) return null;
  try {
    const stat = await fs.stat(path);
    return stat.size;
  } catch {
    return 0;
  }
}

async function assertNoSettlementErrors(path: string | undefined, offset: number | null) {
  if (!path || offset === null) return;
  const text = await fs.readFile(path, 'utf8');
  const tail = text.slice(offset);
  if (/On-chain settlement failed|Buffer is not defined/i.test(tail)) {
    throw new Error('Worker log contains settlement failure after smoke run');
  }
}

async function waitForFramework(server: string, maxWaitMs: number) {
  const started = Date.now();
  while (Date.now() - started < maxWaitMs) {
    try {
      const framework = await api(server, '/api/framework');
      if (framework?.status === 'active') {
        return framework;
      }
    } catch {
      // wait and retry
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for framework readiness at ${server}`);
}

async function main() {
  const { server, webBaseUrl, playerCount, namePrefix, maxWaitMs, resumeDelayMs, finishWaitMs, workerLogPath, directGameCreate } = parseArgs();
  if (playerCount < 4) {
    throw new Error('Comedy demo smoke requires at least 4 players');
  }

  console.log(`\ncomedy-demo-smoke — ${playerCount} players on ${server}\n`);

  await waitForFramework(server, maxWaitMs);
  const workerLogOffset = await readLogOffset(workerLogPath);

  const players: Array<{ name: string; token: string; playerId: string; address: string }> = [];

  for (let i = 0; i < playerCount; i++) {
    const wallet = Wallet.createRandom();
    const name = `${namePrefix}${i + 1}`;
    const auth = await authenticateWithRetry(server, wallet.privateKey, name);
    players.push({ ...auth, address: wallet.address });
    console.log(`  authenticated ${auth.name} (${auth.playerId.slice(0, 8)}...)`);
  }

  let lobbyId: string | null = null;
  let gameId: string | null = null;

  if (directGameCreate) {
    const created = await api(server, '/api/games/create', {
      method: 'POST',
      body: {
        gameType: 'comedy-of-the-commons',
        config: {
          seed: `smoke-${Date.now().toString(36)}`,
          playerIds: players.map((player) => player.playerId),
          maxRounds: 1,
          turnTimerSeconds: 1,
        },
        playerIds: players.map((player) => player.playerId),
        handleMap: Object.fromEntries(players.map((player) => [player.playerId, player.name])),
        teamMap: Object.fromEntries(players.map((player) => [player.playerId, 'FFA'])),
      },
    });
    gameId = created.gameId as string;
    console.log(`\n  direct game: ${gameId}`);
  } else {
    const created = await api(server, '/api/lobbies/create', {
      method: 'POST',
      token: players[0].token,
      body: { gameType: 'comedy-of-the-commons', teamSize: playerCount },
    });
    lobbyId = created.lobbyId as string;
    console.log(`\n  lobby: ${lobbyId}`);

    for (const player of players) {
      const joined = await api(server, '/api/player/lobby/join', {
        method: 'POST',
        token: player.token,
        body: { lobbyId },
      });
      console.log(`  ${player.name} joined (phase: ${joined.phase ?? joined.currentPhase?.id ?? 'unknown'})`);
      if (joined.gameId) gameId = joined.gameId;
    }
  }

  if (!gameId) {
    throw new Error('Flow did not produce a game');
  }

  const games = await api(server, '/api/games');
  const game = Array.isArray(games) ? games.find((entry) => entry.id === gameId) : null;
  const spectator = await api(server, `/api/games/${gameId}/spectator`);
  const replay = await waitForReplay(server, gameId, maxWaitMs);

  await sleep(resumeDelayMs);

  const resumedSpectator = await api(server, `/api/games/${gameId}/spectator`);
  const resumedReplay = await waitForReplay(server, gameId, maxWaitMs);
  const initialProgress = spectator.progressCounter ?? 0;
  const resumedProgress = resumedSpectator.progressCounter ?? 0;
  if (resumedProgress < initialProgress) {
    throw new Error(`Replay/resume regressed progress counter from ${initialProgress} to ${resumedProgress}`);
  }
  if ((resumedReplay.snapshots?.length ?? 0) < (replay.snapshots?.length ?? 0)) {
    throw new Error('Replay/resume reduced snapshot count after reconnect check');
  }

  let finishedGame: any = null;
  let finishedReplaySnapshots: number | null = null;
  if (finishWaitMs > 0) {
    finishedGame = await waitForGameFinished(server, gameId, finishWaitMs);
    const finishedReplay = await waitForReplay(server, gameId, maxWaitMs);
    finishedReplaySnapshots = finishedReplay.snapshots?.length ?? 0;
    await assertNoSettlementErrors(workerLogPath, workerLogOffset);
  }

  const replayUrl = `${webBaseUrl}/replay/${gameId}`;

  console.log('\nSmoke summary');
  console.log(JSON.stringify({
    lobbyId,
    gameId,
    playerCount,
    creationMode: directGameCreate ? 'direct-game' : 'lobby-join',
    gameSummary: game,
    spectatorType: spectator.type,
    replaySnapshots: replay.snapshots?.length ?? 0,
    resumedSpectatorType: resumedSpectator.type,
    resumedReplaySnapshots: resumedReplay.snapshots?.length ?? 0,
    initialProgress,
    resumedProgress,
    finished: finishedGame ? (finishedGame.finished ?? finishedGame.phase === 'finished') : false,
    finishedProgressCounter: finishedGame?.progressCounter ?? null,
    finishedReplaySnapshots,
    replayUrl,
  }, null, 2));
}

main().catch((err) => {
  console.error('\nFatal comedy-demo-smoke error:\n', err);
  process.exit(1);
});
