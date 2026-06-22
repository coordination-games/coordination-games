/**
 * Orchestrator — drives a full batch run from spec to manifest.
 *
 * Flow:
 *   1. Resolve identities (ephemeral wallets or pool) → ResolvedSeat[]
 *   2. Create lobby, join all seats, poll for game auto-start
 *   3. Assemble system prompts, pick runners, run all sessions concurrently
 *   4. Fetch final relay log + snapshot, write manifest
 *   5. Return summary {runDir, lobbyId, gameId, manifest}
 *
 * The harness owns ZERO turn logic — the server serializes turns; off-turn
 * bots call `wait` and block. Phase:"finished" detection is entirely
 * result-driven inside each AgentRunner.
 *
 * References: docs/plans/unified-model-harness.md §§4.5, 7, 8, 9
 */

import { promises as fs, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';
import { api, authenticate, faucetBot, loadPool, registerBotOnChain } from './coga-client.js';
import { BASE_PROTOCOL_PROMPT } from './prompts.js';
import { consequentialCounts } from './transcript.js';
import {
  type AgentRunner,
  backendForModel,
  type LoadedPersona,
  type ResolvedSeat,
  type RunSpec,
  type SessionResult,
  type TranscriptEvent,
} from './types.js';

// ---------------------------------------------------------------------------
// Persona path resolution
// ---------------------------------------------------------------------------

// Package root = two levels up from this file (src/orchestrate.ts → <pkg>).
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLED_PERSONAS_DIR = path.join(PACKAGE_ROOT, 'personas');

/**
 * Resolve a persona reference from a run-spec into an absolute directory path.
 *
 *  - Absolute paths            → used verbatim.
 *  - Explicitly relative paths  → `./foo`, `../foo` resolve against the package
 *                                 root (so `./personas/x` in a spec always finds
 *                                 the bundled personas regardless of cwd).
 *  - Bare names                 → `peaceful-mediator` resolves to the bundled
 *                                 `<pkg>/personas/peaceful-mediator`.
 *
 * If a bare/relative ref does not resolve to an existing directory, we fall back
 * to resolving it against the current working directory so user-supplied
 * external persona dirs still work.
 */
export function resolvePersonaDir(ref: string): string {
  if (path.isAbsolute(ref)) return ref;

  if (ref.startsWith('./') || ref.startsWith('../')) {
    const fromPackage = path.resolve(PACKAGE_ROOT, ref);
    if (existsDirSync(fromPackage)) return fromPackage;
    return path.resolve(ref);
  }

  // Bare name → bundled personas dir first, then cwd fallback.
  const bundled = path.join(BUNDLED_PERSONAS_DIR, ref);
  if (existsDirSync(bundled)) return bundled;
  return path.resolve(ref);
}

function existsDirSync(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Filesystem-safe slug for a run label (used in the run-dir name). */
function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'run'
  );
}

// ---------------------------------------------------------------------------
// Persona loader (§5)
// ---------------------------------------------------------------------------

/**
 * Load a persona bundle from a directory.
 *   - persona.md  (required) — behavior/voice/strategy fragment
 *   - context/*.md (optional) — extra reference material concatenated after
 *   - persona.yaml (optional) — metadata (defaultModel, extraMcpServers)
 *
 * Accepts absolute paths, package-relative paths, or bare bundled-persona
 * names; see resolvePersonaDir for the resolution rules.
 */
export async function loadPersona(dirPath: string): Promise<LoadedPersona> {
  const dir = resolvePersonaDir(dirPath);

  // Required: persona.md
  let personaMd: string;
  try {
    personaMd = await fs.readFile(path.join(dir, 'persona.md'), 'utf8');
  } catch {
    throw new Error(`loadPersona: persona.md not found in ${dir}`);
  }

  // Optional: context/*.md — sort for determinism
  let contextMd = '';
  try {
    const contextDir = path.join(dir, 'context');
    const files = (await fs.readdir(contextDir)).filter((f) => f.endsWith('.md')).sort();
    const parts: string[] = [];
    for (const f of files) {
      parts.push(await fs.readFile(path.join(contextDir, f), 'utf8'));
    }
    if (parts.length) contextMd = `\n\n${parts.join('\n\n')}`;
  } catch {
    // context/ dir absent — fine
  }

  // Optional: persona.yaml
  let defaultModel: string | undefined;
  let extraMcpServers: LoadedPersona['extraMcpServers'];
  try {
    // Lazy import yaml — only available in this package's deps, not in types.ts
    const { parse: parseYaml } = await import('yaml');
    const raw = await fs.readFile(path.join(dir, 'persona.yaml'), 'utf8');
    const meta = parseYaml(raw) as Record<string, unknown>;
    if (typeof meta.defaultModel === 'string') defaultModel = meta.defaultModel;
    if (Array.isArray(meta.extraMcpServers)) {
      // TODO: wire extraMcpServers into runner MCP config (documented, not wired in v1)
      extraMcpServers = meta.extraMcpServers as LoadedPersona['extraMcpServers'];
    }
  } catch {
    // persona.yaml absent — fine
  }

  const systemPromptFragment = personaMd + contextMd;

  return {
    dir,
    systemPromptFragment,
    ...(defaultModel !== undefined ? { defaultModel } : {}),
    ...(extraMcpServers !== undefined ? { extraMcpServers } : {}),
  };
}

// ---------------------------------------------------------------------------
// Prompt assembly (§5)
// ---------------------------------------------------------------------------

export function assemblePrompt(botName: string, persona: LoadedPersona): string {
  return `${BASE_PROTOCOL_PROMPT(botName)}\n\n## Your persona\n${persona.systemPromptFragment}`;
}

// ---------------------------------------------------------------------------
// Transcript writer (§8)
// ---------------------------------------------------------------------------

interface TranscriptWriter {
  onEvent: (e: TranscriptEvent) => void;
  flush: () => Promise<void>;
  eventsFor: (botName: string) => TranscriptEvent[];
}

function makeTranscriptWriter(runDir: string): TranscriptWriter {
  // Map from botName → events accumulated so far
  const eventsByBot = new Map<string, TranscriptEvent[]>();
  // Open write handles (lazy) so we stream events as they arrive
  const handles = new Map<string, fs.FileHandle>();

  async function getHandle(botName: string): Promise<fs.FileHandle> {
    const existing = handles.get(botName);
    if (existing) return existing;
    const botsDir = path.join(runDir, 'bots');
    await fs.mkdir(botsDir, { recursive: true });
    const fh = await fs.open(path.join(botsDir, `${botName}.jsonl`), 'a');
    handles.set(botName, fh);
    return fh;
  }

  function onEvent(e: TranscriptEvent): void {
    // Store in memory
    let list = eventsByBot.get(e.bot);
    if (!list) {
      list = [];
      eventsByBot.set(e.bot, list);
    }
    list.push(e);
    // Write to file asynchronously (fire and forget during session; flush after)
    getHandle(e.bot)
      .then((fh) => fh.write(`${JSON.stringify(e)}\n`))
      .catch((err) => {
        console.error(`[transcript] write error for ${e.bot}: ${err}`);
      });
  }

  async function flush(): Promise<void> {
    // Close all file handles
    for (const [botName, fh] of handles) {
      try {
        await fh.close();
      } catch (err) {
        console.error(`[transcript] close error for ${botName}: ${err}`);
      }
    }
    handles.clear();
  }

  function eventsFor(botName: string): TranscriptEvent[] {
    return eventsByBot.get(botName) ?? [];
  }

  return { onEvent, flush, eventsFor };
}

// ---------------------------------------------------------------------------
// Consequential-action counting (§9)
// ---------------------------------------------------------------------------

// consequentialCounts lives in ./transcript.js (single source of truth). The
// state-version signal it originally tried to use is stripped by the agent
// envelope, so it classifies by tool semantics instead — see that file.

// ---------------------------------------------------------------------------
// Identity resolution (§7)
// ---------------------------------------------------------------------------

async function resolveIdentities(
  spec: RunSpec,
  _adminToken: string,
): Promise<
  {
    botName: string;
    privateKey: string;
    address: string;
    token: string;
    playerId: string;
  }[]
> {
  const resolved: {
    botName: string;
    privateKey: string;
    address: string;
    token: string;
    playerId: string;
  }[] = [];

  if (spec.identities === 'ephemeral') {
    // Count total seats
    const totalSeats = spec.seats.reduce((sum, s) => sum + s.count, 0);
    for (let i = 0; i < totalSeats; i++) {
      const wallet = ethers.Wallet.createRandom();
      const name = `bot${i + 1}-${wallet.address.slice(2, 8)}`;
      const { token, playerId, address } = await authenticate(spec.server, wallet.privateKey, name);
      console.log(`  [identity] ${name} authenticated (${playerId.slice(0, 8)}...)`);
      resolved.push({ botName: name, privateKey: wallet.privateKey, address, token, playerId });
    }
  } else {
    // pool mode — load existing pool bots
    const pool = await loadPool();
    const totalSeats = spec.seats.reduce((sum, s) => sum + s.count, 0);
    if (pool.length < totalSeats) {
      throw new Error(
        `Pool has ${pool.length} bots but spec requires ${totalSeats} seats. ` +
          `Run setup-bot-pool.ts to provision more.`,
      );
    }
    const slice = pool.slice(0, totalSeats);
    for (const bot of slice) {
      const { token, playerId, address } = await authenticate(
        spec.server,
        bot.privateKey,
        bot.name,
      );
      console.log(`  [identity] ${bot.name} (pool) authenticated (${playerId.slice(0, 8)}...)`);
      // Best-effort chain registration + faucet (no-op in mock mode)
      try {
        await faucetBot(spec.server, address);
        await registerBotOnChain(spec.server, bot.privateKey, address, bot.name);
      } catch (err) {
        console.log(`  [identity] ${bot.name} chain setup skipped (mock mode): ${err}`);
      }
      resolved.push({ botName: bot.name, privateKey: bot.privateKey, address, token, playerId });
    }
  }

  return resolved;
}

// ---------------------------------------------------------------------------
// Resolved seats from identity + spec
// ---------------------------------------------------------------------------

async function resolveSeats(
  spec: RunSpec,
  identities: Awaited<ReturnType<typeof resolveIdentities>>,
): Promise<ResolvedSeat[]> {
  const seats: ResolvedSeat[] = [];
  let idx = 0;

  for (const seatSpec of spec.seats) {
    for (let i = 0; i < seatSpec.count; i++) {
      const identity = identities[idx];
      if (!identity) throw new Error(`resolveSeats: identity index ${idx} out of range`);

      const persona = await loadPersona(seatSpec.persona);
      const backend = backendForModel(seatSpec.model);

      seats.push({
        botName: identity.botName,
        privateKey: identity.privateKey,
        persona,
        model: seatSpec.model,
        backend,
      });
      idx++;
    }
  }

  return seats;
}

// ---------------------------------------------------------------------------
// Lobby creation + join + auto-start polling (§4.5 step 2)
// ---------------------------------------------------------------------------

async function createAndJoinLobby(
  spec: RunSpec,
  identities: Awaited<ReturnType<typeof resolveIdentities>>,
): Promise<{ lobbyId: string }> {
  // Create lobby — first authenticated bot creates it
  const firstIdentity = identities[0];
  if (!firstIdentity) throw new Error('No identities resolved');

  console.log(`  [lobby] creating ${spec.game} lobby...`);
  const lobbyBody: Record<string, unknown> = {
    gameType: spec.game,
    ...spec.params,
    // The run-spec's `rounds` is the canonical game-length knob. LobbyDO seeds it
    // into the lobby metadata bag, which the plugin's createConfig reads as
    // maxRounds. (Without this the game silently used its built-in default.)
    ...(typeof spec.rounds === 'number' && spec.rounds >= 1 ? { maxRounds: spec.rounds } : {}),
  };
  const lobby = await api(spec.server, '/api/lobbies/create', {
    method: 'POST',
    body: lobbyBody,
    token: firstIdentity.token,
  });
  const lobbyId: string = lobby.lobbyId;
  console.log(`  [lobby] ${lobbyId} created`);

  // Join all seats
  for (const identity of identities) {
    await api(spec.server, '/api/player/lobby/join', {
      method: 'POST',
      token: identity.token,
      body: { lobbyId },
    });
    console.log(`  [lobby] ${identity.botName} joined`);
  }

  return { lobbyId };
}

/**
 * Poll until the lobby transitions to a started game; return its gameId (or
 * undefined if it never starts before `deadline` / once `isDone()` reports the
 * sessions have ended). Game-generic: auto-start games (TotC, Oathbreaker)
 * resolve in ~1s; games with an active lobby phase (CtL team formation) resolve
 * once the *live* bot sessions drive that phase to completion — which is why the
 * orchestrator launches sessions FIRST and discovers the gameId concurrently,
 * rather than blocking on game-start before any bot is running.
 */
async function pollForGameId(
  server: string,
  lobbyId: string,
  opts: { deadline: number; isDone?: () => boolean },
): Promise<string | undefined> {
  const lookup = async (): Promise<string | undefined> => {
    try {
      const lobbies: Array<{ lobbyId: string; phase: string; gameId?: string }> = await api(
        server,
        '/api/lobbies',
      );
      const entry = lobbies.find((l) => l.lobbyId === lobbyId);
      if (entry?.phase === 'game' && entry.gameId) return entry.gameId;
      // The lobby transitions to phase 'in_progress' (NOT 'game') and exposes the
      // REAL game id at state.gameId. meta.gameId confusingly echoes the lobbyId,
      // so require gid !== lobbyId before trusting it.
      const state = await api(server, `/api/lobbies/${lobbyId}/state`).catch(() => null);
      const gid = state?.gameId ?? state?.state?.gameId;
      if (gid && gid !== lobbyId) return gid;
    } catch {
      // transient — caller retries
    }
    return undefined;
  };

  while (Date.now() < opts.deadline) {
    const gid = await lookup();
    if (gid) {
      console.log(`  [lobby] game started: ${gid}`);
      return gid;
    }
    if (opts.isDone?.()) {
      // Sessions finished without us seeing a start — one last look, then give up.
      const last = await lookup();
      if (last) console.log(`  [lobby] game started: ${last}`);
      return last;
    }
    await sleep(1500);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Run manifest writer (§8)
// ---------------------------------------------------------------------------

async function writeManifest(
  runDir: string,
  runId: string,
  spec: RunSpec,
  lobbyId: string,
  gameId: string,
  seats: ResolvedSeat[],
  sessionResults: Map<string, SessionResult>,
  writer: TranscriptWriter,
  finalSnapshot: unknown,
): Promise<void> {
  const perBot = seats.map((seat) => {
    const result = sessionResults.get(seat.botName) ?? {
      finished: false,
      modelCalls: 0,
      reason: 'error' as const,
    };
    const events = writer.eventsFor(seat.botName);
    const { consequentialTurns, talkOnlyTurns } = consequentialCounts(events);
    return {
      bot: seat.botName,
      persona: seat.persona.dir,
      model: seat.model,
      backend: seat.backend,
      modelCalls: result.modelCalls,
      consequentialTurns,
      talkOnlyTurns,
      finished: result.finished,
      reason: result.reason,
    };
  });

  const manifest = {
    runId,
    spec,
    lobbyId,
    gameId,
    seats: seats.map((s) => ({
      bot: s.botName,
      persona: s.persona.dir,
      model: s.model,
      backend: s.backend,
    })),
    outcome: finalSnapshot,
    perBot,
  };

  await fs.writeFile(path.join(runDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// Relay log fetch + write (§8)
// ---------------------------------------------------------------------------

/**
 * Distill a structured game outcome from an admin inspect payload. Final scores
 * live under `gameInspect.gameState`; `meta.handleMap` maps the winner playerId
 * to a readable handle. Returns null if the inspect is missing.
 */
// biome-ignore lint/suspicious/noExplicitAny: traversing a loose admin-inspect JSON blob.
function buildOutcome(inspect: any): unknown {
  if (!inspect || typeof inspect !== 'object') return null;
  const gi = inspect.gameInspect ?? {};
  const gs = gi.gameState ?? gi.state ?? {};
  // biome-ignore lint/suspicious/noExplicitAny: loose admin-inspect blob.
  const chrome: any = gi.replayChrome ?? {};
  return {
    phase: gs.phase ?? null,
    round: gs.round ?? null,
    isFinished: gi.isOver ?? chrome.isFinished ?? gs.phase === 'finished',
    // Game-agnostic winner from the contract's getReplayChrome — a human-readable
    // label ("Team A", "Player Foo"), undefined for ties / in-progress.
    winnerLabel: chrome.winnerLabel ?? null,
    statusVariant: chrome.statusVariant ?? null,
    // The game's own canonical outcome + summary, captured VERBATIM. The harness
    // never interprets these — that's what keeps it game-agnostic.
    outcome: gi.outcome ?? null,
    summary: gi.summary ?? null,
  };
}

/**
 * Poll the admin inspect until the game reaches phase:finished or `maxMs`
 * elapses, then return the most recent inspect payload (finished or not) so the
 * caller always snapshots the freshest state. Returns null only if every fetch
 * failed. Bounded so a game that never finishes (e.g. a stalled bot under a
 * no-timeout lobby) can't hang the run.
 */
async function waitForFinished(
  server: string,
  gameId: string,
  inspectToken: string,
  maxMs: number,
): Promise<unknown> {
  const deadline = Date.now() + maxMs;
  let last: unknown = null;
  let lastPhase: string | undefined;
  while (true) {
    try {
      const inspect = await api(server, `/api/admin/session/${gameId}/inspect`, {
        headers: { 'X-Admin-Token': inspectToken },
      });
      last = inspect;
      // biome-ignore lint/suspicious/noExplicitAny: loose admin-inspect blob.
      const gi = (inspect as any)?.gameInspect ?? {};
      const gs = gi.gameState ?? gi.state ?? {};
      const phase: string | undefined = gs.phase;
      if (phase !== lastPhase) {
        console.log(`  [orchestrate] game phase=${phase ?? '?'} round=${gs.round ?? '?'}`);
        lastPhase = phase;
      }
      if (gi.isOver === true || phase === 'finished') return inspect;
    } catch (err) {
      console.log(`  [orchestrate] inspect poll failed: ${String(err).slice(0, 120)}`);
    }
    if (Date.now() >= deadline) {
      console.log('  [orchestrate] finish-wait timed out; snapshotting current state.');
      return last;
    }
    await sleep(3000);
  }
}

/**
 * Write the relay ground-truth log from a pre-fetched admin inspect payload.
 * The relay lives at `gameInspect.relayMessages` — one envelope per JSONL line.
 */
// biome-ignore lint/suspicious/noExplicitAny: traversing a loose admin-inspect JSON blob.
async function writeRelayLog(runDir: string, gameId: string, inspect: any): Promise<void> {
  const relayPath = path.join(runDir, 'relay.jsonl');
  const msgs = inspect?.gameInspect?.relayMessages;
  if (Array.isArray(msgs)) {
    const lines = msgs.map((m: unknown) => JSON.stringify(m)).join('\n');
    await fs.writeFile(relayPath, lines ? `${lines}\n` : '');
  } else {
    await fs.writeFile(
      relayPath,
      `${JSON.stringify({ warning: 'no gameInspect.relayMessages in inspect', gameId })}\n`,
    );
  }
}

// ---------------------------------------------------------------------------
// Runner factory (§4.2 / §4.3)
// ---------------------------------------------------------------------------

/**
 * Lazily import and instantiate the runner for the given backend.
 * The runner modules (claude-runner.ts, openrouter-runner.ts) are thin
 * re-export shims over claude.ts / openrouter.ts. If a runner fails to load
 * (e.g. a missing optional dep), we fall back to a stub so the orchestrator
 * stays testable in isolation.
 *
 * The import specifier is a runtime-computed file URL, so tsx/esbuild leave it
 * as a genuine dynamic import (no static resolution) and Node resolves it when
 * called.
 */
async function getRunner(backend: 'claude' | 'openrouter'): Promise<AgentRunner> {
  if (backend === 'claude') {
    try {
      const mod = await import(new URL('./runners/claude-runner.js', import.meta.url).href);
      const Cls = mod.ClaudeAgentRunner as new () => AgentRunner;
      return new Cls();
    } catch (err) {
      console.warn(`[orchestrate] ClaudeAgentRunner not available: ${err}. Using stub.`);
      return makeStubRunner('claude');
    }
  } else {
    try {
      const mod = await import(new URL('./runners/openrouter-runner.js', import.meta.url).href);
      const Cls = mod.OpenRouterAgentRunner as new () => AgentRunner;
      return new Cls();
    } catch (err) {
      console.warn(`[orchestrate] OpenRouterAgentRunner not available: ${err}. Using stub.`);
      return makeStubRunner('openrouter');
    }
  }
}

/**
 * Stub runner — used when the real runner module is not yet built.
 * Immediately resolves with reason:'error' so the orchestrator can still
 * produce a manifest and relay log.
 */
function makeStubRunner(backend: string): AgentRunner {
  return {
    async runSession(opts) {
      opts.onEvent({
        t: Date.now(),
        bot: opts.botName,
        kind: 'session',
        event: 'error',
        detail: `${backend} runner not yet implemented (stub)`,
      });
      // TODO: remove stub once ClaudeAgentRunner / OpenRouterAgentRunner land
      return { finished: false, modelCalls: 0, reason: 'error' };
    },
  };
}

// ---------------------------------------------------------------------------
// Main export: runBatch
// ---------------------------------------------------------------------------

export interface RunBatchResult {
  runDir: string;
  lobbyId: string;
  gameId: string;
  manifest: unknown;
}

/**
 * Drive a full batch run from a parsed RunSpec to a completed run directory.
 *
 * @param spec  The parsed run-spec (see types.ts RunSpec).
 * @returns     Summary with runDir, lobbyId, gameId, and the written manifest.
 */
export async function runBatch(spec: RunSpec): Promise<RunBatchResult> {
  const adminToken = process.env.INSPECTOR_TOKEN ?? 'local-inspector-token';

  // --- Run directory --- (campaign runs carry a label → woven into the dir name)
  const labelSuffix = spec.label ? `-${slugify(spec.label)}` : '';
  const runId = `run-${Date.now()}${labelSuffix}`;
  const runDir = path.resolve(spec.output, runId);
  await fs.mkdir(runDir, { recursive: true });
  console.log(`\n[orchestrate] run ${runId} → ${runDir}`);

  // 1. Resolve identities
  console.log('\n[orchestrate] resolving identities...');
  const identities = await resolveIdentities(spec, adminToken);

  // 2. Resolve seats (persona load, backend selection)
  console.log('[orchestrate] loading personas and resolving seats...');
  const seats = await resolveSeats(spec, identities);
  for (const s of seats) {
    console.log(`  seat: ${s.botName} model=${s.model} backend=${s.backend}`);
  }

  // 3. Create lobby + join all. Does NOT wait for game start.
  console.log('\n[orchestrate] lobby setup...');
  const { lobbyId } = await createAndJoinLobby(spec, identities);

  // 4. Transcript writer
  const writer = makeTranscriptWriter(runDir);

  // 5. Discover the gameId concurrently with the sessions. Games whose first
  //    lobby phase needs player actions (e.g. CtL team formation) only start once
  //    the bots are live, so we MUST launch sessions before the game exists —
  //    blocking on game-start here would deadlock. The poll runs in the
  //    background and resolves the moment the lobby advances to a game.
  let sessionsDone = false;
  const gameIdPromise = pollForGameId(spec.server, lobbyId, {
    deadline: Date.now() + spec.limits.wallClockMsPerRun,
    isDone: () => sessionsDone,
  });

  // 6. Run all sessions concurrently. Each drives whatever phase the lobby is in
  //    (team formation, pledging, gameplay) through to phase:finished — the coga
  //    MCP tool surface already advertises lobby-phase tools, so no special
  //    handling is needed per game.
  console.log(`\n[orchestrate] running ${seats.length} sessions concurrently...`);
  const sessionResults = new Map<string, SessionResult>();

  // Pre-load runners (one per backend type to avoid redundant imports)
  const runnerCache = new Map<string, AgentRunner>();
  for (const seat of seats) {
    if (!runnerCache.has(seat.backend)) {
      runnerCache.set(seat.backend, await getRunner(seat.backend));
    }
  }

  await Promise.all(
    seats.map(async (seat) => {
      const runner = runnerCache.get(seat.backend);
      if (!runner) throw new Error(`No runner for backend ${seat.backend}`);

      const systemPrompt = assemblePrompt(seat.botName, seat.persona);

      const result = await runner.runSession({
        botName: seat.botName,
        privateKey: seat.privateKey,
        server: spec.server,
        systemPrompt,
        model: seat.model,
        limits: {
          maxModelCalls: spec.limits.maxModelCallsPerBot,
          wallClockMs: spec.limits.wallClockMsPerRun,
        },
        onEvent: (e) => writer.onEvent(e),
      });

      sessionResults.set(seat.botName, result);
      console.log(
        `  [${seat.botName}] finished: ${result.finished}, reason: ${result.reason}, modelCalls: ${result.modelCalls}`,
      );
    }),
  );
  sessionsDone = true;

  // 7. Flush transcript files
  await writer.flush();

  // 8. Resolve the gameId (the game has started by now if it started at all) and
  //    snapshot the terminal state. The admin inspect (X-Admin-Token header, not
  //    Bearer) carries BOTH the relay ground truth (gameInspect.relayMessages)
  //    and the game-agnostic outcome (replayChrome/outcome/summary). In batch
  //    mode a bot can exhaust its budget a beat before the final round resolves,
  //    so poll (bounded) for phase:finished rather than snapshotting mid-game.
  const gameId = (await gameIdPromise) ?? '';
  let outcome: unknown = null;
  if (!gameId) {
    console.warn(
      '  [orchestrate] lobby never advanced to a game — writing manifest without an outcome.',
    );
  } else {
    console.log('\n[orchestrate] waiting for finish, then snapshotting (relay + outcome)...');
    const inspectToken = process.env.INSPECTOR_TOKEN ?? 'local-inspector-token';
    const finalInspect = await waitForFinished(spec.server, gameId, inspectToken, 180_000);
    await writeRelayLog(runDir, gameId, finalInspect);
    outcome = buildOutcome(finalInspect);
  }

  // 9. Write manifest
  console.log('[orchestrate] writing manifest...');
  await writeManifest(runDir, runId, spec, lobbyId, gameId, seats, sessionResults, writer, outcome);

  // Load the manifest back to return it
  const manifestRaw = await fs.readFile(path.join(runDir, 'manifest.json'), 'utf8');
  const manifest = JSON.parse(manifestRaw) as unknown;

  console.log(`\n[orchestrate] run complete → ${runDir}\n`);

  return { runDir, lobbyId, gameId, manifest };
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
