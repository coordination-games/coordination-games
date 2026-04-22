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

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ethers } from 'ethers';

// ---------------------------------------------------------------------------
// Pool persistence
// ---------------------------------------------------------------------------

export const POOL_DIR = path.join(os.homedir(), '.coordination');
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
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    throw err;
  }
}

export async function savePool(bots: PoolBot[]): Promise<void> {
  await fs.mkdir(POOL_DIR, { recursive: true });
  await fs.writeFile(POOL_PATH, `${JSON.stringify(bots, null, 2)}\n`, { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// REST helper
// ---------------------------------------------------------------------------

export async function api(
  server: string,
  path: string,
  opts: { method?: string; body?: unknown; token?: string } = {},
  // biome-ignore lint/suspicious/noExplicitAny: dev-script HTTP wrapper. Bot scripts traverse parsed JSON with loose property access (state.units?.filter, result.agentId, etc.); narrowing to `unknown` would require explicit casts at every call site across ~40 spots.
): Promise<any> {
  const res = await fetch(`${server}${path}`, {
    method: opts.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  // biome-ignore lint/suspicious/noExplicitAny: see function return type — same justification.
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = { _raw: text };
  }
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
  let lastErr: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) await sleep(2000 * attempt); // 2s, 4s, 6s, 8s
    try {
      await api(server, `/api/relay/faucet/${address}`);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
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
  const lastMsg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error(`faucet failed after retries: ${lastMsg}`);
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
    name: 'USD Coin',
    version: '2',
    chainId: 10,
    verifyingContract: '0x0000000000000000000000000000000000000001',
  };
  const types = {
    Permit: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'nonce', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
    ],
  };
  const sig = await wallet.signTypedData(domain, types, {
    owner: address,
    spender: '0x0000000000000000000000000000000000000001',
    value: 5_000_000n,
    nonce: 0,
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

  let lastErr: unknown;
  let lastDecoded: DecodedRevert | undefined;
  for (let attempt = 0; attempt < 8; attempt++) {
    if (attempt > 0) await sleep(3000);
    try {
      const result = await api(server, '/api/relay/register', { method: 'POST', body });
      return { registered: true, agentId: result.agentId };
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      const decoded = decodeRevert(msg);
      lastDecoded = decoded;

      // Name already claimed on a previous run — not an error, just skip.
      if (decoded?.name === 'NameTaken' || decoded?.name === 'AlreadyRegistered') {
        return { registered: false };
      }
      // Balance not yet credited — faucet tx still pending. Retry.
      if (decoded?.name === 'ERC20InsufficientBalance') continue;
      // Transient RPC issues — rate limit, timeout — retry.
      if (/rate limit|exceeds defined limit|504|502|timeout|network/i.test(msg)) continue;
      // Known-bad revert we can't recover from — fail fast with a clear message.
      if (decoded) throw new Error(`register reverted: ${decoded.name}() [${decoded.selector}]`);
      // Unknown revert — bubble up the raw error.
      throw err;
    }
  }
  const suffix = lastErr instanceof Error ? lastErr.message : String(lastErr);
  if (lastDecoded?.name === 'ERC20InsufficientBalance') {
    throw new Error(
      `register failed after 8 attempts (24s total): registry transferFrom kept ` +
        `reverting with ERC20InsufficientBalance. The faucet tx likely never mined — ` +
        `check it on the target RPC. Last error: ${suffix}`,
    );
  }
  throw new Error(`register failed after 8 attempts (24s total). Last error: ${suffix}`);
}

// Custom-error selectors we recognize on the registration path. Keep this list
// tight — decoding unknown selectors adds noise, not signal. Compute with
// `keccak256(toBytes("ErrorName(argTypes)")).slice(0, 10)`.
const KNOWN_REVERTS: Record<string, string> = {
  '0x9e4b2685': 'NameTaken', // CoordinationRegistry
  '0x3a81d6fc': 'AlreadyRegistered', // CoordinationRegistry
  '0x430f13b3': 'InvalidName', // CoordinationRegistry
  '0x390772fc': 'NotAgentOwner', // CoordinationRegistry
  '0xe450d38c': 'ERC20InsufficientBalance', // OZ v5
};

interface DecodedRevert {
  selector: string;
  name: string;
}

function decodeRevert(msg: string): DecodedRevert | undefined {
  // OZ v4 ERC20 string revert — no selector, but recognizable.
  if (/transfer amount exceeds balance|insufficient balance/i.test(msg)) {
    return { selector: '', name: 'ERC20InsufficientBalance' };
  }
  const m = msg.match(/0x[a-fA-F0-9]{8}/);
  if (!m) return undefined;
  const selector = m[0].toLowerCase();
  const name = KNOWN_REVERTS[selector];
  return name ? { selector, name } : undefined;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Claude agent — spawn `claude --print` with coga serve --stdio MCP backend.
// Generic prompt: bots read get_guide and play with whatever tools the server
// exposes. The harness has zero per-game knowledge — game rules, tool
// catalogues, and termination criteria all come from the engine via MCP.
// ---------------------------------------------------------------------------

const MAX_RESUMES = 20;

const INITIAL_PROMPT = (
  botName: string,
) => `You are ${botName}, an AI agent on the Coordination Games platform.

YOU ARE ALREADY JOINED TO AN ACTIVE LOBBY. DO NOT call create_lobby or join_lobby — you are already in one.

You have ONE MCP server named "game". Core tools are always present:
  - get_guide          — authoritative rules, win conditions, and per-phase tool catalogue for this game. READ THIS FIRST.
  - get_state          — your current lobby/game state, fog-of-war filtered. Includes \`phase\`, \`currentPhase.tools\` (the tool names callable right now), and game-specific fields described by get_guide.
  - wait_for_update    — long-poll until the next event (turn change, chat, phase transition).
  - chat               — speak. Args: message (string), scope ("team" | "all" | "<display-name>" for DMs). Coordinate when the guide says coordination matters; the guide tells you which scopes are valid.

Every other action is its own named MCP tool with its own JSON schema, registered dynamically from the game's plugin. There is NO generic {type, payload} envelope — call each tool by its declared name with its declared args.

How to play:
1. Call get_guide IMMEDIATELY — it tells you the rules, the phases, which tools apply in each phase, and the win condition.
2. Call get_state — confirms your lobby ID, current phase, teammates, and \`currentPhase.tools\`.
3. Loop until the game is finished (state.phase === "finished" — that's the canonical signal returned by every game's getReplayChrome):
   - Pick the right tool from \`state.currentPhase.tools\` for the current phase.
   - Call it with the args its schema requires.
   - Call wait_for_update to block until something changes, then get_state again.
4. Use chat during gameplay when the guide says coordination matters — solo play often loses.
5. Do NOT stop early, do NOT summarize, do NOT create a new lobby. Keep calling tools until state.phase === "finished".

Error handling — the dispatcher returns structured codes you can self-correct on:
  - UNKNOWN_TOOL:      the tool name isn't in this session's registry. Re-read get_state.currentPhase.tools / get_guide.
  - WRONG_PHASE:       the tool exists but belongs to a different phase. The error payload includes \`currentPhase\` and \`validToolsNow[]\` — switch to one of those.
  - INVALID_ARGS:      args failed JSON-schema validation. Error lists the field issues — fix and retry.
  - VALIDATION_FAILED: args were shape-correct but semantically rejected (e.g. an out-of-range move). Fix the semantics and retry.`;

const RESUME_PROMPT = `The session is still in progress. Keep playing — call get_state, read state.currentPhase.tools, pick the right per-name tool, call it, then wait_for_update. Use chat when the guide says coordination matters. On WRONG_PHASE or UNKNOWN_TOOL, re-read get_state and self-correct. Repeat until state.phase === "finished". Do not summarize.`;

/**
 * Game-over heuristic — game-agnostic.
 *
 * Phase 4.7 standardised `getReplayChrome(snapshot).isFinished` as the
 * canonical "this game is over" signal across every plugin, and every
 * implementation derives it from `snapshot.phase === 'finished'`. The bot
 * harness can't import the plugin to call getReplayChrome (it's a thin
 * Node script that only sees the agent's stdout), so we sniff the same
 * canonical phase string out of the JSON the agent prints when it
 * receives get_state / wait_for_update results.
 *
 * Quote-form variants cover JSON.stringify (`"phase":"finished"`) and the
 * agent's pretty-printed paraphrase (`phase: "finished"` / `phase: 'finished'`).
 * No per-game keywords (no "captured the flag", no "tournament concluded").
 */
const FINISHED_PHASE_PATTERNS: RegExp[] = [
  /"phase"\s*:\s*"finished"/i,
  /'phase'\s*:\s*'finished'/i,
  /\bphase\s*:\s*["']finished["']/i,
];

function looksFinished(output: string): boolean {
  return FINISHED_PHASE_PATTERNS.some((re) => re.test(output));
}

/**
 * Turn one stream-json event line from `claude --print --output-format stream-json`
 * into a concise log line. Returns `null` to skip noisy events (ping, delta
 * fragments). Falls back to a truncated raw line when the shape is unknown.
 */
function summarizeStreamEvent(line: string): string | null {
  let ev: unknown;
  try {
    ev = JSON.parse(line);
  } catch {
    return line.slice(0, 200);
  }
  if (!ev || typeof ev !== 'object') return null;
  const e = ev as Record<string, unknown>;
  const type = e.type as string | undefined;

  if (type === 'system') {
    const sub = e.subtype as string | undefined;
    if (sub === 'init') return `system:init model=${e.model ?? '?'}`;
    return `system:${sub ?? '?'}`;
  }

  if (type === 'assistant') {
    const msg = e.message as { content?: unknown[] } | undefined;
    const parts: string[] = [];
    for (const c of msg?.content ?? []) {
      const block = c as Record<string, unknown>;
      if (block.type === 'text') {
        const text = String(block.text ?? '')
          .replace(/\s+/g, ' ')
          .trim();
        if (text) parts.push(`text: ${text.slice(0, 180)}`);
      } else if (block.type === 'tool_use') {
        const name = block.name ?? '?';
        const input = JSON.stringify(block.input ?? {});
        parts.push(`tool_use ${name}(${input.slice(0, 120)})`);
      } else if (block.type === 'thinking') {
        parts.push('thinking');
      }
    }
    return parts.length ? parts.join(' | ') : null;
  }

  if (type === 'user') {
    const msg = e.message as { content?: unknown[] } | undefined;
    for (const c of msg?.content ?? []) {
      const block = c as Record<string, unknown>;
      if (block.type === 'tool_result') {
        const body = Array.isArray(block.content)
          ? (block.content as Array<Record<string, unknown>>)
              .map((p) => (p.type === 'text' ? String(p.text ?? '') : JSON.stringify(p)))
              .join(' ')
          : JSON.stringify(block.content ?? '');
        const err = block.is_error ? ' ERR' : '';
        return `tool_result${err}: ${body.replace(/\s+/g, ' ').slice(0, 180)}`;
      }
    }
    return null;
  }

  if (type === 'result') {
    const subtype = e.subtype ?? '?';
    const isError = e.is_error ? ' ERR' : '';
    const result = String(e.result ?? '')
      .replace(/\s+/g, ' ')
      .slice(0, 180);
    return `result:${subtype}${isError} ${result}`;
  }

  return `${type ?? '?'}: ${line.slice(0, 140)}`;
}

export interface RunAgentOptions {
  server: string;
  botName: string;
  privateKey: string;
  /**
   * Retained for caller convenience (e.g. fill-bots logs the game type) but
   * NOT consumed by the prompt — the bot learns the game from get_guide.
   */
  gameType?: string;
  model?: string; // default 'haiku'
}

export async function runClaudeAgent(opts: RunAgentOptions): Promise<void> {
  const { server, botName, privateKey, model = 'haiku' } = opts;

  const sessionId = randomUUID();
  const mcpConfig = JSON.stringify({
    mcpServers: {
      game: {
        command: 'npx',
        // `-y coordination-games@latest` forces npx to fetch the current npm
        // release each run instead of falling through to a stale global
        // `coga` binary. Bot fill runs rarely enough that the cold-fetch cost
        // (~a few seconds) is worth not debugging version skew.
        args: [
          '-y',
          'coordination-games@latest',
          'serve',
          '--stdio',
          '--bot-mode',
          '--key',
          privateKey,
          '--name',
          botName,
          '--server-url',
          server,
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
        '--mcp-config',
        mcpConfig,
        '--model',
        model,
        '--verbose',
        '--output-format',
        'stream-json',
        '--max-turns',
        '50',
      ];
      if (isResume) args.push('--resume', sessionId);
      else args.push('--session-id', sessionId);
      args.push(prompt);

      const proc = spawn(process.env.CLAUDE_BIN ?? 'claude', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
      });

      let output = '';
      let stdoutBuf = '';
      proc.stdout?.on('data', (d: Buffer) => {
        const text = d.toString();
        output += text;
        stdoutBuf += text;
        const lines = stdoutBuf.split('\n');
        stdoutBuf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line) continue;
          const pretty = summarizeStreamEvent(line);
          if (pretty) console.log(`[${botName}] ${pretty}`);
        }
      });
      proc.stderr?.on('data', (d: Buffer) => {
        d.toString()
          .split('\n')
          .filter(Boolean)
          .forEach((line) => {
            process.stderr.write(`[${botName}!] ${line.slice(0, 140)}\n`);
          });
      });
      proc.on('close', () => resolve(output));
      proc.on('error', reject);
    });
  }

  let output = await runOnce(INITIAL_PROMPT(botName), false);
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
