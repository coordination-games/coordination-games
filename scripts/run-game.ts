#!/usr/bin/env tsx
/**
 * run-game.ts — Generic multi-bot game runner.
 *
 * End-to-end test harness that mirrors the real player flow:
 *   ephemeral wallets → auth → lobby → `coga serve --stdio` MCP server → Claude agent
 *
 * Works with any registered game type. For phased games (CtL), the script
 * pre-completes team formation and class selection programmatically so agents
 * drop straight into the game phase rather than navigating the lobby UI.
 *
 * How it works:
 *   1. Create N ephemeral wallets and authenticate each with the server
 *   2. Create a lobby and join all bots
 *   3. For phased games (CtL): pre-complete team formation + class selection via REST
 *   4. Launch one `claude --print` subprocess per bot, each backed by its own
 *      `coga serve --stdio` MCP server. The MCP server re-authenticates using
 *      the same private key → same agentId → finds the in-progress game.
 *   5. Agents call get_guide, then play to completion with the MCP tools.
 *
 * Usage:
 *   tsx scripts/run-game.ts
 *   GAME_TYPE=capture-the-lobster TEAM_SIZE=2 tsx scripts/run-game.ts
 *   GAME_TYPE=capture-the-lobster TEAM_SIZE=3 tsx scripts/run-game.ts
 *   GAME_TYPE=oathbreaker BOT_COUNT=6 tsx scripts/run-game.ts
 *   GAME_SERVER=https://api.capturethelobster.com tsx scripts/run-game.ts
 *
 * Env vars:
 *   GAME_SERVER  — server URL (default: http://localhost:8787)
 *   GAME_TYPE    — game type slug (default: oathbreaker)
 *   BOT_COUNT    — total bots (default: 4 for oathbreaker, TEAM_SIZE*2 for ctl)
 *   TEAM_SIZE    — players per team for team-based games (default: 2)
 *   MODEL        — claude model alias passed to --model (default: haiku)
 *
 * Prerequisites:
 *   wrangler dev running in packages/workers-server/ (or GAME_SERVER pointing at prod)
 *   claude CLI installed and authenticated (~/.claude credentials)
 *   coga CLI available via npx (workspace package at packages/cli)
 */

import { ethers } from 'ethers';
import { randomUUID } from 'crypto';
import { spawn } from 'child_process';

const SERVER    = process.env.GAME_SERVER ?? 'http://localhost:8787';
const GAME_TYPE = process.env.GAME_TYPE   ?? 'oathbreaker';
const TEAM_SIZE = parseInt(process.env.TEAM_SIZE ?? '2');
const BOT_COUNT = parseInt(
  process.env.BOT_COUNT ?? (GAME_TYPE === 'oathbreaker' ? '4' : String(TEAM_SIZE * 2))
);
const MODEL = process.env.MODEL ?? 'haiku';

// ---------------------------------------------------------------------------
// REST helper
// ---------------------------------------------------------------------------

async function api(
  path: string,
  opts: { method?: string; body?: unknown; token?: string } = {},
): Promise<any> {
  const res = await fetch(`${SERVER}${path}`, {
    method:  opts.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let json: any;
  try { json = JSON.parse(text); } catch { json = { _raw: text }; }
  if (!res.ok) throw new Error(`${opts.method ?? 'GET'} ${path} → ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Run one claude --print agent with coga serve as its stdio MCP server.
// coga serve re-authenticates using the same private key → same agentId →
// finds the lobby/game session created above by the script.
// ---------------------------------------------------------------------------

const MAX_RESUMES = 20;  // safety cap — don't loop forever

async function runClaudeAgent(
  botName: string,
  privateKey: string,
): Promise<void> {
  const sessionId = randomUUID();
  const mcpConfig = JSON.stringify({
    mcpServers: {
      game: {
        command: 'npx',
        args: [
          'coga', 'serve', '--stdio', '--bot-mode',
          '--key', privateKey,
          '--name', botName,
          '--server-url', SERVER,
        ],
      },
    },
  });

  const ctlHints = GAME_TYPE === 'capture-the-lobster' ? `
This is Capture the Lobster — a hex-grid tactical game. Key rules:
- You move by submitting a direction array like ["N"], ["NE"], or ["STAY"]
- You have fog of war — use the chat tool to coordinate with teammates
- Win by capturing the enemy flag and bringing it to your base
- Check get_state for your position, visible enemies, and flag locations
` : '';

  const initialPrompt = `You are ${botName}, an AI agent playing ${GAME_TYPE}. You are in an active game.
${ctlHints}
Play the game to completion using the "game" MCP server tools.

1. Call get_guide ONCE to learn the rules — read it carefully, it lists ALL available tools
2. Call get_state to see the current state
3. Explore ALL your available tools — not just submit_move. Use chat to coordinate with teammates, share intel about enemy positions, discuss strategy. Social tools are critical to winning.
4. Each turn: check state, communicate with your team via chat, THEN submit your move
5. Keep calling wait_for_update and submitting moves until gameOver: true
6. Do NOT stop early or summarize — keep playing every round

IMPORTANT: You have a chat tool — USE IT EVERY TURN. Tell your teammate what you see, where enemies are, and what you plan to do. Coordinate! Solo play loses.`;

  const resumePrompt = `The game is still in progress. Continue playing — call wait_for_update, chat with your teammate about what you see, then submit_move. Repeat until gameOver: true. Do NOT summarize or stop early. USE THE CHAT TOOL every turn to coordinate.`;

  /** Run one claude --print invocation; resolves with stdout text. */
  function runOnce(prompt: string, isResume: boolean): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = [
        '--print',
        '--dangerously-skip-permissions',
        '--strict-mcp-config',
        '--mcp-config', mcpConfig,
        '--model', MODEL,
        '--max-turns', '50',
      ];
      if (isResume) {
        args.push('--resume', sessionId);
      } else {
        args.push('--session-id', sessionId);
      }
      args.push(prompt);

      const proc = spawn('claude', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
      });

      let output = '';
      proc.stdout?.on('data', (d: Buffer) => {
        const text = d.toString();
        output += text;
        text.split('\n').filter(Boolean).forEach(line =>
          console.log(`[${botName}] ${line.slice(0, 140)}`)
        );
      });

      proc.stderr?.on('data', (d: Buffer) => {
        d.toString().split('\n').filter(Boolean).forEach(line =>
          process.stderr.write(`[${botName}!] ${line.slice(0, 140)}\n`)
        );
      });

      proc.on('close', () => resolve(output));
      proc.on('error', reject);
    });
  }

  // Initial run
  let output = await runOnce(initialPrompt, false);

  // Resume loop — keep going until game over or safety cap
  for (let i = 0; i < MAX_RESUMES; i++) {
    const lower = output.toLowerCase();
    if (lower.includes('gameover: true') || lower.includes('game over') ||
        lower.includes('game complete') || lower.includes('game completed') ||
        lower.includes('phase: "finished"') || lower.includes("phase: 'finished'") ||
        lower.includes('game is over') || lower.includes('game has ended') ||
        lower.includes('final results') || lower.includes('final balance') ||
        lower.includes('tournament concluded') || lower.includes('tournament has finished') ||
        lower.includes('all 12 rounds') || lower.includes('round 12') ||
        lower.includes('captured the flag') || lower.includes('"winner"') ||
        lower.includes('winner:') || lower.includes('game finished')) {
      console.log(`[${botName}] Game finished after ${i + 1} session(s)`);
      return;
    }
    console.log(`[${botName}] Resuming (session ${i + 2})...`);
    output = await runOnce(resumePrompt, true);
  }
  console.log(`[${botName}] Hit resume cap (${MAX_RESUMES})`);
}

// ---------------------------------------------------------------------------
// Pre-complete lobby phases (team formation + class selection) for phased games.
// This lets Claude agents start directly in the game phase rather than
// spending time (or failing) on the 4–9 minute lobby timers.
// ---------------------------------------------------------------------------

const CLASSES = ['rogue', 'knight', 'mage'] as const;

async function waitForPhase(token: string, target: string, maxSecs = 30): Promise<any> {
  for (let i = 0; i < maxSecs * 2; i++) {
    const state = await api('/api/player/state', { token }).catch(() => null);
    if (!state) { await sleep(500); continue; }
    const phaseId = state.currentPhase?.id ?? state.phase;
    if (phaseId === target) return state;
    // phase='game' or phase='starting' means the lobby transitioned to a game
    if (state.phase === 'game' || state.phase === 'starting') return state;
    // type='state_update' means we're already in the game (GameRoomDO response)
    if (state.type === 'state_update') return state;
    if (phaseId === 'failed') throw new Error(`Lobby failed: ${state.error}`);
    await sleep(500);
  }
  throw new Error(`Timed out waiting for phase "${target}"`);
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function completeLobbyPhases(
  bots: { name: string; token: string; playerId: string }[],
  teamSize: number,
): Promise<void> {
  // ---- Team formation ----
  console.log('  Forming teams...');
  const teams: { name: string; token: string; playerId: string }[][] = [];
  for (let t = 0; t < bots.length / teamSize; t++) {
    teams.push(bots.slice(t * teamSize, (t + 1) * teamSize));
  }

  for (const team of teams) {
    const proposer = team[0];
    // Proposer invites each teammate one by one
    for (let i = 1; i < team.length; i++) {
      const invitee = team[i];
      const res = await api('/api/player/lobby/action', {
        method: 'POST',
        token: proposer.token,
        body: { type: 'propose_team', payload: { targetHandle: invitee.name } },
      });
      // Extract the team ID from the phase view — proposer's team has them as a member
      const phaseTeams = res.currentPhase?.view?.teams ?? [];
      const proposerTeam = phaseTeams.find((t: any) => t.members.includes(proposer.playerId));
      const teamId = proposerTeam?.id;
      console.log(`    ${proposer.name} proposed → ${invitee.name} (team ${teamId?.slice(0,8)})`);

      // Invitee accepts
      await api('/api/player/lobby/action', {
        method: 'POST',
        token: invitee.token,
        body: { type: 'accept_team', payload: { teamId } },
      });
      console.log(`    ${invitee.name} accepted`);
    }
  }

  // ---- Wait for class-selection phase ----
  console.log('  Waiting for class-selection...');
  await waitForPhase(bots[0].token, 'class-selection');

  // ---- Class selection ----
  console.log('  Selecting classes...');
  for (let i = 0; i < bots.length; i++) {
    const bot = bots[i];
    // Use position within team so each team gets the same class mix
    const unitClass = CLASSES[(i % teamSize) % CLASSES.length];
    await api('/api/player/lobby/action', {
      method: 'POST',
      token: bot.token,
      body: { type: 'choose_class', payload: { unitClass } },
    });
    console.log(`    ${bot.name} → ${unitClass}`);
  }

  // ---- Wait for game to start ----
  console.log('  Waiting for game to start...');
  await waitForPhase(bots[0].token, 'game');
  console.log('  Game started!\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`\nrun-game.ts — ${BOT_COUNT} bots playing ${GAME_TYPE} on ${SERVER}\n`);

  // 1. Create wallets and authenticate
  console.log('Creating wallets and authenticating...');
  const bots: {
    wallet: ethers.Wallet;
    name: string;
    token: string;
    playerId: string;
  }[] = [];

  for (let i = 0; i < BOT_COUNT; i++) {
    const wallet = ethers.Wallet.createRandom();
    const name   = `bot${i + 1}-${wallet.address.slice(2, 8)}`;
    const { token, playerId } = await authenticate(wallet, name);
    bots.push({ wallet, name, token, playerId });
    console.log(`  ${name} authenticated (${playerId.slice(0, 8)}...)`);
  }

  // 2. Create the lobby
  console.log(`\nCreating ${GAME_TYPE} lobby...`);
  const lobbyBody = GAME_TYPE === 'oathbreaker'
    ? { gameType: GAME_TYPE, teamSize: BOT_COUNT }
    : { gameType: GAME_TYPE, teamSize: TEAM_SIZE };

  const lobby = await api('/api/lobbies/create', { method: 'POST', body: lobbyBody, token: bots[0].token });
  const lobbyId = lobby.lobbyId;
  console.log(`  Lobby: ${lobbyId}`);

  // 3. All bots join the lobby
  console.log('Joining lobby...');
  for (const bot of bots) {
    const res = await api('/api/player/lobby/join', {
      method: 'POST',
      token: bot.token,
      body: { lobbyId },
    });
    console.log(`  ${bot.name} joined (phase: ${res.phase})`);
  }

  // 4. Pre-complete lobby phases for phased games (CtL and similar).
  //    For OATHBREAKER, the 4th join already started the game — skip.
  //    For CtL: do team formation + class selection programmatically so
  //    Claude agents only see the game phase, not the lengthy lobby flow.
  const lobbyState = await api('/api/player/state', { token: bots[0].token });
  const hasLobbyPhases = lobbyState.currentPhase?.id === 'team-formation';
  if (hasLobbyPhases) {
    console.log('\nPre-completing lobby phases...');
    await completeLobbyPhases(bots, TEAM_SIZE);
  }

  // 5. Run all claude agents concurrently — each starts its own coga serve
  console.log('\nAll bots playing...\n');
  await Promise.all(bots.map(bot => runClaudeAgent(bot.name, bot.wallet.privateKey)));

  console.log('\nDone.\n');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
