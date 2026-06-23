/**
 * Self-contained coga client helpers for the Unified Model Harness.
 *
 * Ported (copied, not imported across the workspace boundary) from
 * scripts/lib/bot-agent.ts so this package stands alone. Keep behavior
 * identical to the proven scripts — these are the auth / pool / faucet /
 * on-chain-register paths the existing fill-bots and run-game flows use.
 *
 * Also adds `cogaServeCommand`: the { command, args } both backends spawn for
 * `coga serve` so the MCP integration point is identical across them (and can be
 * pointed at a local build via COGA_SERVE_CMD).
 */

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
  opts: { method?: string; body?: unknown; token?: string; headers?: Record<string, string> } = {},
  // biome-ignore lint/suspicious/noExplicitAny: dev-script HTTP wrapper. Bot scripts traverse parsed JSON with loose property access (state.units?.filter, result.agentId, etc.); narrowing to `unknown` would require explicit casts at every call site.
): Promise<any> {
  const res = await fetch(`${server}${path}`, {
    method: opts.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      // Admin endpoints (/api/admin/...) authenticate via the X-Admin-Token
      // header, NOT a Bearer token. Callers pass it through here.
      ...(opts.headers ?? {}),
    },
    // `exactOptionalPropertyTypes` rejects `body: undefined`, so only attach
    // the body when present rather than passing an explicit undefined.
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
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
// coga serve --stdio invocation
//
// Both backends connect to the SAME coga MCP server — the single integration
// point (§3). This returns the { command, args } to spawn it, which the runners
// feed to the MCP stdio transport (OpenRouter) or the claude --mcp-config
// (Claude).
//
// Default: `npx -y coordination-games@latest serve ...` — forces npx to fetch
// the current npm release each run instead of falling through to a stale global
// `coga` binary.
//
// Override: set `COGA_SERVE_CMD` to spawn a LOCAL build instead of the published
// release — e.g. `COGA_SERVE_CMD="npx tsx packages/cli/src/index.ts"` from the
// repo root, or `COGA_SERVE_CMD="node packages/cli/dist/index.js"`. The override
// is the program + any leading args; the `serve ...` arguments are appended.
// This is what lets a LOCAL pipeline change (e.g. the COGA_DISABLE_PLUGINS knob)
// take effect for the bots without publishing — the harness's research/dev loop.
// ---------------------------------------------------------------------------

export interface CogaServeInvocation {
  command: string;
  args: string[];
}

export function cogaServeCommand(
  privateKey: string,
  botName: string,
  server: string,
): CogaServeInvocation {
  const serveArgs = [
    'serve',
    '--stdio',
    '--bot-mode',
    '--key',
    privateKey,
    '--name',
    botName,
    '--server-url',
    server,
  ];
  const override = process.env.COGA_SERVE_CMD?.trim();
  if (override) {
    const [command, ...leadingArgs] = override.split(/\s+/);
    return { command: command ?? 'npx', args: [...leadingArgs, ...serveArgs] };
  }
  return { command: 'npx', args: ['-y', 'coordination-games@latest', ...serveArgs] };
}
