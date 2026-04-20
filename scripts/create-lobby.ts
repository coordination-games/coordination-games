#!/usr/bin/env tsx
// Create a lobby on prod as an ephemeral (random) identity, so fill-bots sees
// every seat empty. Prints the lobbyId on stdout.
import { ethers } from 'ethers';
import { authenticate, api, faucetBot, registerBotOnChain } from './lib/bot-agent.js';

const SERVER = process.env.GAME_SERVER ?? 'https://api.capturethelobster.com';
const GAME_TYPE = process.env.GAME_TYPE ?? 'capture-the-lobster';
const TEAM_SIZE = parseInt(process.env.TEAM_SIZE ?? '2', 10);

async function main() {
  const wallet = ethers.Wallet.createRandom();
  const name = `creator-${wallet.address.slice(2, 8).toLowerCase()}`;
  console.error(`creator: ${name} (${wallet.address})`);

  // On prod (chain mode) must faucet + register before authenticating
  const faucet = await faucetBot(SERVER, wallet.address);
  console.error(`faucet: ${faucet ? 'ok' : 'skip (mock?)'}`);
  const reg = await registerBotOnChain(SERVER, wallet.privateKey, wallet.address, name);
  console.error(`register: ${JSON.stringify(reg)}`);

  const { token } = await authenticate(SERVER, wallet.privateKey, name);
  console.error('authenticated');

  const body = GAME_TYPE === 'oathbreaker'
    ? { gameType: GAME_TYPE, teamSize: TEAM_SIZE }
    : { gameType: GAME_TYPE, teamSize: TEAM_SIZE };
  const lobby = await api(SERVER, '/api/lobbies/create', { method: 'POST', body, token });
  console.log(lobby.lobbyId);
  console.error(`lobby: ${lobby.lobbyId} (${GAME_TYPE}, teamSize=${TEAM_SIZE})`);
}

main().catch((err) => { console.error(err); process.exit(1); });
