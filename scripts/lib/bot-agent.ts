/**
 * Shared bot helpers for dev test scripts.
 *
 * Used by:
 *   scripts/setup-bot-pool.ts  — register + faucet bots, persist to pool.json
 *   scripts/fill-bots.ts        — fill an existing lobby with pool bots
 *   scripts/run-game.ts         — create a lobby + fill with ephemeral bots
 *
 * The bot pool lives at ~/.coordination/bot-pool.json alongside the normal CLI
 * config so it survives across runs.
 */

import { ethers } from 'ethers';
import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

// ---------------------------------------------------------------------------
// Pool persistence
// ---------------------------------------------------------------------------

export const POOL_DIR  = path.join(os.homedir(), '.coordination');
export const POOL_PATH = path.join(POOL_DIR, 'bot-pool.json');

export interface PoolBot {
  name: string;
  address: string;
  privateKey: string;
  registeredAt: string;
  faucetedAt?: string;
}

export async function loadPool(): Promise<PoolBot[]> {
  try {
    const raw = await fs.readFile(POOL_PATH, 'utf8');
    return JSON.parse(raw) as PoolBot[];
  } catch (err: any) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

export async function savePool(bots: PoolBot[]): Promise<void> {
  await fs.mkdir(POOL_DIR, { recursive: true });
  await fs.writeFile(POOL_PATH, JSON.stringify(bots, null, 2) + '\n', { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// REST helper
// ---------------------------------------------------------------------------

export async function api(
  server: string,
  path: string,
  opts: { method?: string; body?: unknown; token?: string } = {},
): Promise<any> {
  const res = await fetch(`${server}${path}`, {
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
  if (!res.ok) {
    throw new Error(`${opts.method ?? 'GET'} ${path} → ${res.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export async function authenticate(
  server: string,
  privateKey: string,
  name: string,
): Promise<{ token: string; playerId: string; address: string }> {
  const wallet = new ethers.Wallet(privateKey);
  const { nonce, message } = await api(server, '/api/player/auth/challenge', { method: 'POST' });
  const signature = await wallet.signMessage(message);
  const result = await api(server, '/api/player/auth/verify', {
    method: 'POST',
    body: { nonce, signature, address: wallet.address, name },
  });
  return { token: result.token, playerId: result.agentId, address: wallet.address };
}

// ---------------------------------------------------------------------------
// Faucet (best-effort — no-op in mock mode)
// ---------------------------------------------------------------------------

export async function faucetBot(server: string, address: string): Promise<boolean> {
  let lastErr: any;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) await sleep(2000 * attempt); // 2s, 4s, 6s, 8s
    try {
      await api(server, `/api/relay/faucet/${address}`);
      return true;
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      // 503 = mock mode, no on-chain faucet. That's fine.
      if (/503/.test(msg)) return false;
      // Transient RPC issues — rate limit, timeout — retry.
      if (/rate limit|exceeds defined limit|504|502|timeout|network/i.test(msg)) {
        lastErr = err;
        continue;
      }
      throw err;
    }
  }
  throw new Error(`faucet failed after retries: ${lastErr?.message ?? lastErr}`);
}

// ---------------------------------------------------------------------------
// On-chain registration — required on prod (chain mode). No-op in mock mode
// where auth.ts skips the ERC-8004 ownership check.
//
// MockUSDC.permit() is a no-op _approve, so any well-formed v/r/s works.
// The Registry then pulls REGISTRATION_FEE + INITIAL_CREDITS_USDC = 5 USDC
// from the user via transferFrom, so faucet must complete first.
// ---------------------------------------------------------------------------

export async function registerBotOnChain(
  server: string,
  privateKey: string,
  address: string,
  name: string,
): Promise<{ registered: boolean; agentId?: string }> {
  // Skip if the server doesn't support register (mock mode may still expose
  // the endpoint — registering is harmless there).
  const deadline = Math.floor(Date.now() / 1000) + 3600;

  // Sign a permit for 5 USDC (MockUSDC ignores the sig; real USDC would
  // validate it against its DOMAIN_SEPARATOR). Spender is irrelevant in mock.
  const wallet = new ethers.Wallet(privateKey);
  const domain = {
    name:   'USD Coin',
    version: '2',
    chainId: 10,
    verifyingContract: '0x0000000000000000000000000000000000000001',
  };
  const types = {
    Permit: [
      { name: 'owner',    type: 'address' },
      { name: 'spender',  type: 'address' },
      { name: 'value',    type: 'uint256' },
      { name: 'nonce',    type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
    ],
  };
  const sig = await wallet.signTypedData(domain, types, {
    owner:    address,
    spender:  '0x0000000000000000000000000000000000000001',
    value:    5_000_000n,
    nonce:    0,
    deadline,
  });
  const split = ethers.Signature.from(sig);

  // Retry register — faucet mint may not be mined for a few seconds.
  const body = {
    name,
    address,
    agentURI: `https://coordination.games/agent/${address}`,
    permitDeadline: deadline,
    v: split.v,
    r: split.r,
    s: split.s,
  };

  let lastErr: any;
  for (let attempt = 0; attempt < 8; attempt++) {
    if (attempt > 0) await sleep(3000);
    try {
      const result = await api(server, '/api/relay/register', { method: 'POST', body });
      return { registered: true, agentId: result.agentId };
    } catch (err: any) {
      lastErr = err;
      const msg = String(err?.message ?? err);
      // Balance not yet credited — faucet tx still pending. Retry.
      //   0xe450d38c = ERC20InsufficientBalance (OZ v5 custom error)
      //   "transfer amount exceeds balance" (OZ v4 string)
      if (
        /transfer amount exceeds balance|insufficient balance|0xe450d38c|execution reverted/i.test(msg)
      ) continue;
      // Transient RPC issues — rate limit, timeout — retry.
      if (/rate limit|exceeds defined limit|504|502|timeout|network/i.test(msg)) continue;
      // Already registered (from a previous run)
      if (/already registered|name.*taken/i.test(msg)) {
        return { registered: false };
      }
      throw err;
    }
  }
  throw new Error(
    `register failed after 8 attempts (24s total, 3s backoff). ` +
    `Most likely the faucet tx never mined, so the registry's transferFrom ` +
    `(REGISTRATION_FEE + INITIAL_CREDITS_USDC = 5 USDC) keeps reverting with ` +
    `ERC20InsufficientBalance (0xe450d38c). Check the faucet tx on the ` +
    `target RPC. Last error: ${lastErr?.message ?? lastErr}`,
  );
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Claude agent — spawn `claude --print` with coga serve --stdio MCP backend.
// Generic prompt: bots read get_guide and play with whatever tools are exposed.
// ---------------------------------------------------------------------------

const MAX_RESUMES = 20;

const INITIAL_PROMPT = (botName: string, gameType: string) => `You are ${botName}, an AI agent playing ${gameType} on the Coordination Games platform.

YOU ARE ALREADY JOINED TO AN ACTIVE LOBBY. DO NOT call create_lobby or join_lobby — you are already in one. Call get_state first to see its ID, phase, other players, and available actions.

You have ONE MCP server named "game". Its tool list is authoritative: each phase tool (team formation, class selection, gameplay) is its own named MCP tool with its own JSON schema. Discover them from the MCP surface and from state.currentPhase.tools. Core tools always present: get_state, get_guide, wait_for_update, chat.

How to play:
1. Call get_state IMMEDIATELY — shows your current lobby, phase, teammates, and the list of tool names callable right now in state.currentPhase.tools.
2. Call get_guide ONCE to learn rules + which tools apply in each phase.
3. Loop until gameOver: true or lobby phase becomes "finished":
   - Call the per-phase tool by name with its own args (do NOT pass a generic {type, payload}).
   - Call wait_for_update to block until something changes, then get_state again.
4. Use chat during gameplay — solo play loses, coordinate with your teammate. chat args: message="hi", scope="team" (or "all", or a display name for DMs).
5. Do NOT stop early, do NOT summarize, do NOT create a new lobby. Keep calling tools until the game finishes.

Tool examples:

capture-the-lobster (team-based hex game):
  - Lobby team-formation phase: propose_team targetHandle=bob, then the other player accept_team teamId=team_14; leave_team to back out.
  - Lobby class-selection phase: choose_class unitClass=rogue (or knight / mage).
  - Gameplay phase: move path=N,NE (ordered hex directions, up to your class speed; empty path = stay).

oathbreaker (repeated pledging game):
  - Gameplay pledging phase: propose_pledge amount=10 (both players must match to advance).
  - Gameplay deciding phase: submit_decision decision=C (or D).

Error handling — self-correct on structured errors:
  - UNKNOWN_TOOL: the tool name isn't in this session's registry. Re-check get_state / get_guide.
  - WRONG_PHASE: the tool exists but belongs to a different phase. The error includes the current phase and validToolsNow[] — switch to one of those.
  - INVALID_ARGS: args failed schema validation. Error lists the field issues.
  - VALIDATION_FAILED: args were shape-correct but semantically rejected (e.g. move out of range). Fix the semantics and retry.`;

const RESUME_PROMPT = `The session is still in progress. Keep playing — call get_state, read state.currentPhase.tools, pick the right per-name tool, call it, then wait_for_update. Use chat during gameplay. On WRONG_PHASE or UNKNOWN_TOOL, re-read get_state and self-correct. Repeat until gameOver: true. Do not summarize.`;

const GAME_OVER_MARKERS = [
  'gameover: true', 'game over', 'game complete', 'game completed',
  'phase: "finished"', "phase: 'finished'",
  'game is over', 'game has ended', 'final results', 'final balance',
  'tournament concluded', 'tournament has finished',
  '"winner"', 'winner:', 'game finished', 'captured the flag',
];

function looksFinished(output: string): boolean {
  const lower = output.toLowerCase();
  return GAME_OVER_MARKERS.some(m => lower.includes(m));
}

export interface RunAgentOptions {
  server:     string;
  botName:    string;
  privateKey: string;
  gameType:   string;
  model?:     string;  // default 'haiku'
}

export async function runClaudeAgent(opts: RunAgentOptions): Promise<void> {
  const { server, botName, privateKey, gameType, model = 'haiku' } = opts;

  const sessionId = randomUUID();
  const mcpConfig = JSON.stringify({
    mcpServers: {
      game: {
        command: 'npx',
        args: [
          'coga', 'serve', '--stdio', '--bot-mode',
          '--key',        privateKey,
          '--name',       botName,
          '--server-url', server,
        ],
      },
    },
  });

  function runOnce(prompt: string, isResume: boolean): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = [
        '--print',
        '--dangerously-skip-permissions',
        '--strict-mcp-config',
        '--mcp-config', mcpConfig,
        '--model',      model,
        '--max-turns',  '50',
      ];
      if (isResume) args.push('--resume', sessionId);
      else          args.push('--session-id', sessionId);
      args.push(prompt);

      const proc = spawn(process.env.CLAUDE_BIN ?? 'claude', args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } });

      let output = '';
      proc.stdout?.on('data', (d: Buffer) => {
        const text = d.toString();
        output += text;
        text.split('\n').filter(Boolean).forEach(line =>
          console.log(`[${botName}] ${line.slice(0, 140)}`),
        );
      });
      proc.stderr?.on('data', (d: Buffer) => {
        d.toString().split('\n').filter(Boolean).forEach(line =>
          process.stderr.write(`[${botName}!] ${line.slice(0, 140)}\n`),
        );
      });
      proc.on('close', () => resolve(output));
      proc.on('error', reject);
    });
  }

  let output = await runOnce(INITIAL_PROMPT(botName, gameType), false);
  for (let i = 0; i < MAX_RESUMES; i++) {
    if (looksFinished(output)) {
      console.log(`[${botName}] Finished after ${i + 1} session(s)`);
      return;
    }
    console.log(`[${botName}] Resuming (session ${i + 2})...`);
    output = await runOnce(RESUME_PROMPT, true);
  }
  console.log(`[${botName}] Hit resume cap (${MAX_RESUMES})`);
}

// ---------------------------------------------------------------------------
// Capacity helper — mirrors the frontend's math in LobbiesPage.tsx.
// Future cleanup: add `capacity` to /api/lobbies so this lives server-side.
// ---------------------------------------------------------------------------

export function deriveCapacity(gameType: string, teamSize: number): number {
  return gameType === 'oathbreaker' ? teamSize : teamSize * 2;
}
