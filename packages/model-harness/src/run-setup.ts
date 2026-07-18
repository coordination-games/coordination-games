import { ethers } from 'ethers';
import { api, authenticate, faucetBot, loadPool, registerBotOnChain } from './coga-client.js';
import { loadPersona } from './persona.js';
import { type CampaignSpec, isTournamentRun } from './tournament-types.js';
import { backendForModel, type ResolvedSeat, type RunSpec } from './types.js';

export type ResolvedIdentity = {
  readonly botName: string;
  readonly privateKey: string;
  readonly address: string;
  readonly token: string;
  readonly playerId: string;
};

export async function resolveIdentities(spec: RunSpec): Promise<ResolvedIdentity[]> {
  return spec.identities === 'ephemeral'
    ? resolveEphemeralIdentities(spec)
    : resolvePoolIdentities(spec);
}

export async function resolveSeats(
  spec: RunSpec,
  identities: readonly ResolvedIdentity[],
): Promise<ResolvedSeat[]> {
  const seats: ResolvedSeat[] = [];
  let index = 0;
  for (const seatSpec of spec.seats) {
    for (let count = 0; count < seatSpec.count; count++) {
      const identity = identities[index];
      if (!identity) throw new Error(`resolveSeats: identity index ${index} out of range`);
      seats.push({
        botName: identity.botName,
        privateKey: identity.privateKey,
        persona: await loadPersona(seatSpec.persona),
        model: seatSpec.model,
        backend: backendForModel(seatSpec.model),
        ...(seatSpec.modelConfig ? { modelConfig: seatSpec.modelConfig } : {}),
      });
      index++;
    }
  }
  return seats;
}

export async function createAndJoinLobby(
  spec: CampaignSpec,
  identities: readonly ResolvedIdentity[],
): Promise<string> {
  const first = identities[0];
  if (!first) throw new Error('No identities resolved');
  const lobby = await api(spec.server, '/api/lobbies/create', {
    method: 'POST',
    token: first.token,
    body: {
      gameType: spec.game,
      ...spec.params,
      maxRounds: spec.rounds,
      ...(isTournamentRun(spec) ? { tournament: spec.tournament } : {}),
      ...(spec.disablePlugins?.length ? { disabledPlugins: spec.disablePlugins } : {}),
    },
  });
  if (!isRecord(lobby) || typeof lobby.lobbyId !== 'string')
    throw new Error('Lobby creation omitted lobbyId');
  for (const identity of identities) {
    await api(spec.server, '/api/player/lobby/join', {
      method: 'POST',
      token: identity.token,
      body: { lobbyId: lobby.lobbyId },
    });
  }
  return lobby.lobbyId;
}

export async function pollForGameId(input: {
  readonly server: string;
  readonly lobbyId: string;
  readonly deadline: number;
  readonly isDone: () => boolean;
}): Promise<string | undefined> {
  while (Date.now() < input.deadline) {
    const gameId = await lookupGameId(input.server, input.lobbyId);
    if (gameId || input.isDone())
      return gameId ?? (await lookupGameId(input.server, input.lobbyId));
    await sleep(1500);
  }
  return undefined;
}

async function resolveEphemeralIdentities(spec: RunSpec): Promise<ResolvedIdentity[]> {
  const identities: ResolvedIdentity[] = [];
  const total = spec.seats.reduce((sum, seat) => sum + seat.count, 0);
  for (let index = 0; index < total; index++) {
    const wallet = ethers.Wallet.createRandom();
    const botName = `bot${index + 1}-${wallet.address.slice(2, 8)}`;
    const identity = await authenticate(spec.server, wallet.privateKey, botName);
    identities.push({ botName, privateKey: wallet.privateKey, ...identity });
  }
  return identities;
}

async function resolvePoolIdentities(spec: RunSpec): Promise<ResolvedIdentity[]> {
  const total = spec.seats.reduce((sum, seat) => sum + seat.count, 0);
  const bots = await loadPool();
  if (bots.length < total)
    throw new Error(`Pool has ${bots.length} bots but spec requires ${total} seats.`);
  return Promise.all(
    bots.slice(0, total).map(async (bot) => {
      const identity = await authenticate(spec.server, bot.privateKey, bot.name);
      try {
        await faucetBot(spec.server, identity.address);
        await registerBotOnChain(spec.server, bot.privateKey, identity.address, bot.name);
      } catch (error) {
        console.log(`  [identity] ${bot.name} chain setup skipped (mock mode): ${String(error)}`);
      }
      return { botName: bot.name, privateKey: bot.privateKey, ...identity };
    }),
  );
}

async function lookupGameId(server: string, lobbyId: string): Promise<string | undefined> {
  try {
    const lobbies = await api(server, '/api/lobbies');
    if (Array.isArray(lobbies)) {
      const entry = lobbies.find((value) => isRecord(value) && value.lobbyId === lobbyId);
      if (isRecord(entry) && entry.phase === 'game' && typeof entry.gameId === 'string')
        return entry.gameId;
    }
    const state = await api(server, `/api/lobbies/${lobbyId}/state`).catch(() => undefined);
    const record = isRecord(state) ? state : undefined;
    const nested = record && isRecord(record.state) ? record.state : undefined;
    const gameId = record?.gameId ?? nested?.gameId;
    return typeof gameId === 'string' && gameId !== lobbyId ? gameId : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
