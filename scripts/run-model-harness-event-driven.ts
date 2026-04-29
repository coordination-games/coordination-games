#!/usr/bin/env tsx
import { ethers } from 'ethers';
import { authenticate } from './lib/bot-agent.js';

const SERVER = process.env.GAME_SERVER || 'http://127.0.0.1:3101';
const BOT_COUNT = Number(process.env.BOT_COUNT || '4');
const MAX_WAIT_MS = Number(process.env.MAX_WAIT_MS || '300000');

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function getNumber(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

async function api(path: string, body?: Record<string, unknown>, token?: string) {
  const res = await fetch(`${SERVER}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(JSON.stringify(data));
  return data;
}

async function adminApi(path: string) {
  const res = await fetch(`${SERVER}${path}`, {
    headers: { 'X-Admin-Token': 'local-inspector-token' },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(JSON.stringify(data));
  return data;
}

function chatRelayFor(
  _bot: { name: string; playerId: string },
  message: string,
  recipientName?: string,
) {
  const scope =
    recipientName && recipientName !== 'all'
      ? { kind: 'dm', recipientHandle: recipientName }
      : 'all';
  return { type: 'messaging', pluginId: 'basic-chat', scope, data: { body: message } };
}

async function callTool(bot: { token: string }, toolName: string, args: Record<string, unknown>) {
  return api('/api/player/tool', { toolName, args }, bot.token);
}

async function run() {
  console.log(`server=${SERVER} game=tragedy-of-the-commons bots=${BOT_COUNT}`);

  const bots: { name: string; token: string; playerId: string }[] = [];
  const defaultNames = ['Alicia Commons', 'Bob Timber', 'Carol Current', 'Dave Ore'];
  const suffix = Math.random().toString(36).slice(2, 8);

  for (let i = 0; i < BOT_COUNT; i++) {
    const wallet = ethers.Wallet.createRandom();
    const baseName = defaultNames[i] ?? `Bot ${i + 1}`;
    const name = `${baseName} ${suffix}`;
    const auth = await authenticate(SERVER, wallet.privateKey, name);
    bots.push({ name: baseName, token: auth.token, playerId: auth.playerId });
    console.log(`joined ${baseName} ${auth.playerId}`);
  }

  const lobby = await api(
    '/api/lobbies/create',
    { gameType: 'tragedy-of-the-commons', teamSize: BOT_COUNT },
    bots[0]?.token,
  );
  console.log(`lobby=${lobby.lobbyId}`);

  for (const bot of bots) {
    const joined = await api('/api/player/lobby/join', { lobbyId: lobby.lobbyId }, bot.token);
    console.log(`joined ${bot.name} phase=${String(joined.phase ?? 'unknown')}`);
  }

  await new Promise((resolve) => setTimeout(resolve, 1000));

  const lobbyInspect = await adminApi(`/api/admin/session/${lobby.lobbyId}/inspect`);
  const gameId = typeof lobbyInspect.gameId === 'string' ? lobbyInspect.gameId : null;
  if (!gameId) throw new Error(`Lobby did not start a game`);
  console.log(`game=${gameId}`);

  const startTime = Date.now();
  let lastRound = 0;

  while (Date.now() - startTime < MAX_WAIT_MS) {
    const inspect = await adminApi(`/api/admin/session/${gameId}/inspect`).catch(() => null);
    if (!inspect) {
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }

    const state = inspect.gameInspect?.state || inspect.game?.state || inspect.state;
    if (!isRecord(state)) {
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }

    const round = getNumber(state.round, 0);
    const phase = typeof state.phase === 'string' ? state.phase : 'unknown';
    const currentPlayerIndex = getNumber(state.currentPlayerIndex, 0);
    const winner = state.winner;

    if (round !== lastRound) {
      console.log(`=== ROUND ${round} === phase=${phase}`);
      lastRound = round;
    }

    if (phase === 'finished' || winner) {
      console.log(`Game finished! Winner: ${winner || 'none'}`);
      break;
    }

    const playerIds = Array.isArray(state.players)
      ? state.players.map((p: { id: string }) => p.id)
      : [];
    const currentPlayerId = playerIds[currentPlayerIndex];
    const currentBot = bots.find((b) => b.playerId === currentPlayerId);

    if (!currentBot) {
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }

    const submittedActions = isRecord(state.submittedActions) ? state.submittedActions : {};
    if (
      submittedActions[currentPlayerId] !== undefined &&
      submittedActions[currentPlayerId] !== null
    ) {
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }

    console.log(`  -> ${currentBot.name}'s turn`);

    const chatMsg = `Round ${round} from ${currentBot.name}`;
    await callTool(currentBot, 'plugin_relay', {
      relay: chatRelayFor(currentBot, chatMsg),
    }).catch(() => {});

    const ecosystems = ['sunspine-aquifer', 'old-growth-ring', 'magma-vent'];
    const actionArgs = {
      type: 'extract_commons',
      ecosystemId: ecosystems[Math.floor(Math.random() * ecosystems.length)],
      level: 'low',
    };

    try {
      await callTool(currentBot, actionArgs.type, actionArgs);
      console.log(`     action: ${actionArgs.type}`);
    } catch (err) {
      console.log(`     action failed: ${String(err).slice(0, 80)}`);
      await callTool(currentBot, 'pass', {});
    }

    await new Promise((r) => setTimeout(r, 500));
  }

  console.log(`========================================`);
  console.log(`Game complete: ${gameId}`);
  console.log(`Inspector: http://127.0.0.1:5173/inspect/${gameId}`);
  console.log(`Spectator: http://127.0.0.1:5173/game/${gameId}`);
  console.log(`========================================`);
}

run().catch(console.error);
