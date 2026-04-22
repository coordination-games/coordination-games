#!/usr/bin/env tsx
/**
 * test-ctl-moves.ts — Test CtL game by directly submitting moves via REST.
 * No Claude agents, just direct API calls to diagnose the turn freeze bug.
 */

import { ethers } from 'ethers';

const SERVER = process.env.GAME_SERVER ?? 'https://api.games.coop';
const TEAM_SIZE = 2;
const BOT_COUNT = TEAM_SIZE * 2;

async function api(
  path: string,
  opts: { method?: string; body?: unknown; token?: string } = {},
  // biome-ignore lint/suspicious/noExplicitAny: dev smoke-test wrapper; callers walk parsed JSON with loose property access and narrowing at every site would duplicate the server's D1/DO response shapes here.
): Promise<any> {
  const res = await fetch(`${SERVER}${path}`, {
    method: opts.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  // biome-ignore lint/suspicious/noExplicitAny: see function return type.
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = { _raw: text };
  }
  if (!res.ok)
    throw new Error(`${opts.method ?? 'GET'} ${path} → ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

async function authenticate(
  wallet: ethers.Wallet,
  name: string,
): Promise<{ token: string; playerId: string }> {
  const { nonce, message } = await api('/api/player/auth/challenge', { method: 'POST' });
  const signature = await wallet.signMessage(message);
  const result = await api('/api/player/auth/verify', {
    method: 'POST',
    body: { nonce, signature, address: wallet.address, name },
  });
  return { token: result.token, playerId: result.agentId };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

const CLASSES = ['rogue', 'knight'] as const;

async function main() {
  console.log(`\ntest-ctl-moves.ts — ${BOT_COUNT} bots, direct REST, ${SERVER}\n`);

  // 1. Auth
  console.log('Authenticating...');
  const bots: { wallet: ethers.Wallet; name: string; token: string; playerId: string }[] = [];
  for (let i = 0; i < BOT_COUNT; i++) {
    const wallet = ethers.Wallet.createRandom();
    const name = `test${i + 1}-${wallet.address.slice(2, 8)}`;
    const { token, playerId } = await authenticate(wallet, name);
    bots.push({ wallet, name, token, playerId });
    console.log(`  ${name} (${playerId.slice(0, 8)})`);
  }

  // 2. Create lobby and join
  console.log('\nCreating lobby...');
  const lobby = await api('/api/lobbies/create', {
    method: 'POST',
    token: bots[0].token,
    body: { gameType: 'capture-the-lobster', teamSize: TEAM_SIZE },
  });
  console.log(`  Lobby: ${lobby.lobbyId}`);

  for (const bot of bots) {
    const res = await api('/api/player/lobby/join', {
      method: 'POST',
      token: bot.token,
      body: { lobbyId: lobby.lobbyId },
    });
    console.log(`  ${bot.name} joined (phase: ${res.phase})`);
  }

  // 3. Team formation (unified tool surface: propose_team / accept_team)
  console.log('\nForming teams...');
  const teams = [bots.slice(0, TEAM_SIZE), bots.slice(TEAM_SIZE)];
  for (const team of teams) {
    for (let i = 1; i < team.length; i++) {
      // Propose
      await api('/api/player/tool', {
        method: 'POST',
        token: team[0].token,
        body: { toolName: 'propose_team', args: { targetHandle: team[i].name } },
      });

      // Get phase view to find team ID. `/api/player/state` returns the
      // unified spectator envelope — per-phase view lives under state.state.
      const state = await api('/api/player/state', { token: team[0].token });
      const phaseTeams = state.state?.currentPhase?.view?.teams ?? [];
      const proposerTeam = phaseTeams.find((t: { members: string[] }) =>
        t.members.includes(team[0].playerId),
      );
      const teamId = proposerTeam?.id;
      console.log(`  ${team[0].name} → ${team[i].name} (team ${teamId?.slice(0, 8)})`);

      // Accept
      await api('/api/player/tool', {
        method: 'POST',
        token: team[i].token,
        body: { toolName: 'accept_team', args: { teamId } },
      });
      console.log(`  ${team[i].name} accepted`);
    }
  }

  // 4. Wait for class-selection
  console.log('\nWaiting for class-selection...');
  for (let i = 0; i < 60; i++) {
    const state = await api('/api/player/state', { token: bots[0].token }).catch(() => null);
    const phaseId = state?.currentPhase?.id ?? state?.state?.currentPhase?.id;
    const phase = state?.state?.phase ?? state?.phase;
    if (phaseId === 'class-selection' || phase === 'game') break;
    await sleep(500);
  }

  // 5. Class selection
  console.log('Selecting classes...');
  for (let i = 0; i < bots.length; i++) {
    const unitClass = CLASSES[i % TEAM_SIZE];
    await api('/api/player/tool', {
      method: 'POST',
      token: bots[i].token,
      body: { toolName: 'choose_class', args: { unitClass } },
    });
    console.log(`  ${bots[i].name} → ${unitClass}`);
  }

  // 6. Wait for game to start
  console.log('\nWaiting for game start...');
  let gameStarted = false;
  for (let i = 0; i < 60; i++) {
    const state = await api('/api/player/state', { token: bots[0].token }).catch(() => null);
    if (state?.turn !== undefined) {
      console.log('  Game started!');
      gameStarted = true;
      break;
    }
    await sleep(500);
  }
  if (!gameStarted) {
    console.log('  TIMEOUT waiting for game start');
    return;
  }

  // 7. Play turns — all bots submit STAY (empty path) every turn
  console.log('\nPlaying turns (all STAY)...\n');
  let lastTurn = -1;
  let stuckCount = 0;

  for (let attempt = 0; attempt < 200; attempt++) {
    // Get state for first bot
    const state = await api('/api/player/state', { token: bots[0].token });
    const turn = state.turn ?? '?';
    const gameOver = state.gameOver ?? false;

    if (turn !== lastTurn) {
      const aliveUnits = state.units?.filter((u: { alive: boolean }) => u.alive)?.length ?? '?';
      const totalUnits = state.units?.length ?? '?';
      console.log(`--- Turn ${turn} (gameOver=${gameOver}, alive=${aliveUnits}/${totalUnits}) ---`);
      lastTurn = turn;
      stuckCount = 0;
    } else {
      stuckCount++;
      if (stuckCount > 10) {
        console.log(`\n*** STUCK at turn ${turn} for ${stuckCount} attempts! ***`);
        // Get detailed state
        for (const bot of bots) {
          const s = await api('/api/player/state', { token: bot.token });
          const unit = s.units?.find(() => true);
          console.log(
            `  ${bot.name}: alive=${unit?.alive ?? '?'} pos=(${unit?.position?.q},${unit?.position?.r}) moveSubmissions=${JSON.stringify(s.moveSubmissions?.length ?? '?')}`,
          );
        }
        break;
      }
    }

    if (gameOver) {
      console.log('\nGame over!');
      const finalState = await api('/api/player/state', { token: bots[0].token });
      console.log(`Winner: ${finalState.winner ?? 'draw'}`);
      break;
    }

    // Submit STAY for each bot
    for (const bot of bots) {
      try {
        const moveResult = await api('/api/player/tool', {
          method: 'POST',
          token: bot.token,
          body: { toolName: 'move', args: { path: [] } },
        });
        if (!moveResult.ok) {
          console.log(`  ${bot.name} move REJECTED: ${JSON.stringify(moveResult.error)}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`  ${bot.name} move ERROR: ${msg.slice(0, 100)}`);
      }
    }

    await sleep(300);
  }

  console.log('\nDone.');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
