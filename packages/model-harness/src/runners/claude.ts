/**
 * ClaudeAgentRunner — backend: `claude --print` subprocess with local ~/.claude creds.
 *
 * Ports runClaudeAgent from scripts/lib/bot-agent.ts into the AgentRunner
 * interface. Key changes vs the original:
 *
 *  1. Instead of console.log, each stream-json line is parsed and emitted as a
 *     structured TranscriptEvent via opts.onEvent.
 *
 *  2. Termination: detects `"phase":"finished"` in structured tool_result
 *     payloads (not regex on raw stdout). Extracts stateVersion and relayCursor
 *     from the result envelope for the consequential-action signal (§9).
 *
 *  3. Resume loop is capped by opts.limits.maxModelCalls (total across all
 *     sessions, not per-session).
 *
 *  4. Wall-clock cap: kills the subprocess if opts.limits.wallClockMs is
 *     exceeded.
 *
 *  5. systemPrompt is prepended to the initial user prompt (--print has no
 *     separate system-prompt flag; prepending is idiomatic for the CLI).
 *
 *  6. MCP config is built with cogaServeCommand() so both backends share exactly
 *     the same coga serve invocation.
 *
 * MUST NOT set ANTHROPIC_API_KEY — local ~/.claude creds only.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Session-boot lock. Concurrent `claude` session boots race their MCP servers'
// startup against the session's tool-list snapshot; solo boots reliably attach.
// All seats of a run live in this process (orchestrate's Promise.all), so a
// module-level FIFO lock serializing spawn → init makes attach deterministic
// while keeping gameplay fully concurrent.
// ---------------------------------------------------------------------------
let bootQueueTail: Promise<void> = Promise.resolve();

function acquireBootLock(): Promise<() => void> {
  let release!: () => void;
  const held = new Promise<void>((res) => {
    release = res;
  });
  const acquired = bootQueueTail.then(() => release);
  bootQueueTail = bootQueueTail.then(() => held);
  return acquired;
}

import { cogaServeCommand } from '../coga-client.js';
import {
  BASE_PROTOCOL_PROMPT,
  BOOT_VERIFY_PROMPT,
  REJOIN_PROMPT,
  RESUME_PROMPT,
} from '../prompts.js';
import type { AgentRunner, RunSessionOptions, SessionResult, TranscriptEvent } from '../types.js';
import { claudeCliModel } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers — parse stream-json lines into TranscriptEvents
// ---------------------------------------------------------------------------

/**
 * Extract the text of tool_result blocks from a user-turn content array.
 * Returns a concatenated string (empty string when nothing extractable).
 */
function extractToolResultBody(content: unknown): string {
  if (Array.isArray(content)) {
    return (content as Array<Record<string, unknown>>)
      .map((p) => (p.type === 'text' ? String(p.text ?? '') : JSON.stringify(p)))
      .join(' ');
  }
  return JSON.stringify(content ?? '');
}

/**
 * Try to parse a JSON string; return undefined on failure.
 */
function tryParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/**
 * Check whether a parsed tool result value contains `"phase":"finished"`.
 * Walks the top-level object (and one nested `result` key) since coga wraps
 * the actual game state inside a result envelope.
 */
function isFinishedResult(parsed: unknown): boolean {
  if (!parsed || typeof parsed !== 'object') return false;
  const obj = parsed as Record<string, unknown>;

  // Direct: { phase: "finished", ... }
  if (obj.phase === 'finished') return true;

  // Nested inside a `result` key: { result: { phase: "finished" } }
  if (obj.result && typeof obj.result === 'object') {
    const inner = obj.result as Record<string, unknown>;
    if (inner.phase === 'finished') return true;
  }

  // Also check `state` key for resilience
  if (obj.state && typeof obj.state === 'object') {
    const inner = obj.state as Record<string, unknown>;
    if (inner.phase === 'finished') return true;
  }

  return false;
}

/**
 * Extract stateVersion and relayCursor from a tool result for the
 * consequential-action signal (§9, blueprint).
 */
function extractCursors(parsed: unknown): { stateVersion?: number; relayCursor?: number } {
  if (!parsed || typeof parsed !== 'object') return {};
  const obj = parsed as Record<string, unknown>;

  // Look in the top level and in common envelope keys
  const candidates = [obj, obj.result, obj.state, obj.meta].filter(
    (x): x is Record<string, unknown> => !!x && typeof x === 'object',
  );

  let stateVersion: number | undefined;
  let relayCursor: number | undefined;

  for (const c of candidates) {
    if (stateVersion === undefined && typeof c.knownStateVersion === 'number') {
      stateVersion = c.knownStateVersion;
    }
    if (stateVersion === undefined && typeof c.stateVersion === 'number') {
      stateVersion = c.stateVersion;
    }
    if (relayCursor === undefined && typeof c.sinceIdx === 'number') {
      relayCursor = c.sinceIdx;
    }
    if (relayCursor === undefined && c.meta && typeof c.meta === 'object') {
      const meta = c.meta as Record<string, unknown>;
      if (typeof meta.sinceIdx === 'number') relayCursor = meta.sinceIdx;
    }
  }

  // Use conditional spreads to avoid exactOptionalPropertyTypes conflicts.
  return {
    ...(stateVersion !== undefined ? { stateVersion } : {}),
    ...(relayCursor !== undefined ? { relayCursor } : {}),
  };
}

// ---------------------------------------------------------------------------
// Stream-json line → TranscriptEvents
//
// The claude --print --output-format stream-json subprocess emits one JSON
// object per line with the following shapes we care about:
//
//   { type:"system",    subtype:"init", model:"..." }
//   { type:"assistant", message:{ content:[...] } }
//   { type:"user",      message:{ content:[{ type:"tool_result", ... }] } }
//   { type:"result",    subtype:"success"|"error_max_turns"|..., ... }
//
// We emit TranscriptEvents from the assistant and user turns. The result line
// is used only for its error signal (detected externally via the finished flag).
// ---------------------------------------------------------------------------

interface ParsedLine {
  /** Zero or more events to emit from this stream-json line. */
  events: TranscriptEvent[];
  /**
   * True if this line contains a tool_result payload that signals phase:finished.
   * The runner tracks this across lines to decide whether to resume.
   */
  seenFinished: boolean;
}

function parseStreamLine(line: string, bot: string, _model: string): ParsedLine {
  const ev = tryParse(line);
  if (!ev || typeof ev !== 'object') return { events: [], seenFinished: false };

  const e = ev as Record<string, unknown>;
  const type = e.type as string | undefined;
  const events: TranscriptEvent[] = [];
  let seenFinished = false;
  const t = Date.now();

  // -------------------------------------------------------------------------
  // assistant turn — emit model_response (text + tool_calls)
  // -------------------------------------------------------------------------
  if (type === 'assistant') {
    const msg = e.message as { content?: unknown[]; usage?: unknown } | undefined;
    const content = msg?.content ?? [];

    let text: string | undefined;
    const toolCalls: { name: string; args: unknown }[] = [];

    for (const c of content) {
      const block = c as Record<string, unknown>;
      if (block.type === 'text') {
        const t2 = String(block.text ?? '').trim();
        if (t2) text = (text ?? '') + t2;
      } else if (block.type === 'tool_use') {
        const name = String(block.name ?? '');
        const args = block.input ?? {};
        toolCalls.push({ name, args });
        // Also emit a tool_call event for each call (cleaner for the transcript)
        events.push({ t, bot, kind: 'tool_call', name, args });
      }
      // thinking blocks: no event emitted (content is model-internal)
    }

    const responseEvent: TranscriptEvent = {
      t,
      bot,
      kind: 'model_response',
      ...(text !== undefined ? { text } : {}),
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      ...(msg?.usage !== undefined ? { usage: msg.usage } : {}),
    };
    events.push(responseEvent);
    return { events, seenFinished };
  }

  // -------------------------------------------------------------------------
  // user turn — emit tool_result events
  // -------------------------------------------------------------------------
  if (type === 'user') {
    const msg = e.message as { content?: unknown[] } | undefined;
    for (const c of msg?.content ?? []) {
      const block = c as Record<string, unknown>;
      if (block.type !== 'tool_result') continue;

      const isError = block.is_error === true;
      const rawBody = extractToolResultBody(block.content);

      // Parse the result body to get structured data for finished detection
      // and cursor extraction. The coga MCP server stringifies the JSON into
      // a text block, so rawBody is typically a JSON string.
      const parsed = tryParse(rawBody);

      if (isFinishedResult(parsed)) seenFinished = true;

      const { stateVersion, relayCursor } = extractCursors(parsed);

      // Determine which tool this result is for. The claude --print stream
      // doesn't always include the tool name on the result block, but when it
      // does it's in block.tool_use_id or (rarely) block.name. We'll use the
      // tool_use_id as a fallback name to keep the event non-null.
      const name =
        typeof block.name === 'string' && block.name
          ? block.name
          : typeof block.tool_use_id === 'string'
            ? `[${block.tool_use_id}]`
            : 'unknown';

      const resultEvent: TranscriptEvent = {
        t,
        bot,
        kind: 'tool_result',
        name,
        result: parsed ?? rawBody,
        ...(isError ? { isError: true } : {}),
        ...(stateVersion !== undefined ? { stateVersion } : {}),
        ...(relayCursor !== undefined ? { relayCursor } : {}),
      };
      events.push(resultEvent);
    }
    return { events, seenFinished };
  }

  // system:init — emit a model_request-ish note so the transcript shows the model
  if (type === 'system') {
    const sub = e.subtype as string | undefined;
    if (sub === 'init' && typeof e.model === 'string') {
      // Not a formal model_request (we don't have the messages array here), but
      // we emit a session:start on the first init if we haven't already — that
      // is handled outside this function. Nothing else needed here.
    }
    return { events: [], seenFinished: false };
  }

  return { events, seenFinished };
}

// ---------------------------------------------------------------------------
// ClaudeAgentRunner
// ---------------------------------------------------------------------------

export class ClaudeAgentRunner implements AgentRunner {
  async runSession(opts: RunSessionOptions): Promise<SessionResult> {
    const {
      botName,
      privateKey,
      server,
      systemPrompt,
      model,
      limits,
      onEvent,
      disablePlugins,
      rotateAfterTurns,
    } = opts;
    // Session-rotation flag (off by default — RunSpec.rotateAfterTurns). When
    // set, every subprocess is capped at this many turns instead of 50, and a
    // healthy-but-unfinished exit (hit the turn cap, not a timeout/dead MCP
    // attach) rotates to a FRESH session instead of --resume-ing the
    // accumulated conversation. See maxTurnsArg / the resume loop below.
    const rotationEnabled = typeof rotateAfterTurns === 'number' && rotateAfterTurns > 0;
    const maxTurnsArg = rotationEnabled ? String(rotateAfterTurns) : '50';
    // The seat model may carry a backend-routing prefix (`anthropic/claude-haiku`)
    // or a friendly tier alias the `claude` CLI doesn't accept raw — normalize to
    // a CLI-valid `--model` value. The original seat model stays in the manifest.
    const cliModel = claudeCliModel(model);

    // Mutable: regenerated when an MCP-attach retry needs a FRESH session
    // (the failed session id already exists server-side and its tool list is
    // frozen without coga — resuming it can never recover, see runOnceGuarded)
    // and, when rotationEnabled, on every turn-cap rotation (see the resume
    // loop below) — both cases start a subprocess with `--session-id` instead
    // of `--resume`.
    let sessionId = randomUUID();
    const deadline = Date.now() + limits.wallClockMs;

    // One private working dir per seat (see the spawn cwd comment below).
    const botCwd = mkdtempSync(path.join(tmpdir(), `coga-${botName.slice(0, 24)}-`));

    const coga = cogaServeCommand(privateKey, botName, server);
    const mcpConfig = JSON.stringify({
      mcpServers: {
        coga: {
          command: coga.command,
          args: coga.args,
        },
      },
    });

    // Env for the `claude` subprocess; the coga MCP server it spawns inherits
    // this, so COGA_DISABLE_PLUGINS (if any) reaches coga's client-side pipeline.
    // MCP_TIMEOUT: give coga's startup (node boot + wallet auth round-trips
    // against a possibly busy dev server) more patience before the session
    // gives up on the server — pairs with the attach guard below.
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      MCP_TIMEOUT: process.env.MCP_TIMEOUT ?? '60000',
      ...(disablePlugins && disablePlugins.length > 0
        ? { COGA_DISABLE_PLUGINS: disablePlugins.join(',') }
        : {}),
    };

    let totalModelCalls = 0;
    let finished = false;

    // Emit session start
    onEvent({ t: Date.now(), bot: botName, kind: 'session', event: 'start' });

    /**
     * Run one `claude --print` subprocess and return the accumulated raw
     * stdout (needed for the looksFinished fallback). Emits TranscriptEvents
     * as lines arrive.
     *
     * Boot is SERIALIZED across seats (module-level lock, released on the
     * init line): every solo session boot observed attaches its MCP server;
     * only concurrent boots race the tool-list snapshot. Play remains fully
     * concurrent — the lock covers spawn → init only (~seconds per seat).
     */
    const runOnce = async (
      prompt: string,
      isResume: boolean,
    ): Promise<{
      seenFinished: boolean;
      timedOut: boolean;
      mcpFailed?: boolean;
      limitHit?: boolean;
    }> => {
      const releaseBoot = await acquireBootLock();
      let bootReleased = false;
      const releaseBootOnce = () => {
        if (!bootReleased) {
          bootReleased = true;
          releaseBoot();
        }
      };
      return new Promise((resolve, reject) => {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          releaseBootOnce();
          resolve({ seenFinished: false, timedOut: true });
          return;
        }

        const args: string[] = [
          '--print',
          // HERMETIC SESSION — load no user/project/local settings. Two reasons:
          // (1) determinism: the operator's SessionStart hooks + user config
          //     slow session init enough that the coga MCP server is still
          //     "pending" when the tool list snapshots — measured 4/4 connected
          //     hermetic vs 1/4 with default settings under identical 4-seat
          //     concurrency (2026-07-03). (2) science: a research bot must not
          //     carry the operator's personal context (global CLAUDE.md, hooks,
          //     connectors) into gameplay.
          '--setting-sources',
          '',
          '--strict-mcp-config',
          '--mcp-config',
          mcpConfig,
          '--model',
          cliModel,
          '--verbose',
          '--output-format',
          'stream-json',
          '--max-turns',
          maxTurnsArg,
          // Tool scoping — two anti-patterns we must avoid, learned the hard way:
          //  • `--tools ""` ALSO strips the MCP tools (not just built-ins), so the
          //    model is left with nothing and hallucinates <function_calls> text
          //    → zero real tool calls, game never moves.
          //  • `--dangerously-skip-permissions` bypasses the deny rules below.
          // So: allow ONLY the coga MCP server (auto-approved, no prompt hang in
          // headless), and explicitly DENY every distracting built-in/injected
          // tool a weak model wanders into (observed: ToolSearch, Skill, Bash,
          // Read). Deny rules take precedence over the default allow set. This
          // list is the LAST flag before the --session-id/--resume push, whose
          // leading '--' bounds the variadic.
          '--allowedTools',
          'mcp__coga',
          '--disallowedTools',
          'Bash',
          'Edit',
          'Write',
          'Read',
          'Glob',
          'Grep',
          'Task',
          'Agent',
          'WebFetch',
          'WebSearch',
          'TodoWrite',
          'NotebookEdit',
          'ToolSearch',
          'Skill',
          'Monitor',
          'ExitPlanMode',
          'AskUserQuestion',
        ];
        if (isResume) {
          args.push('--resume', sessionId);
        } else {
          args.push('--session-id', sessionId);
        }
        args.push(prompt);

        const proc = spawn(process.env.CLAUDE_BIN ?? 'claude', args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: childEnv,
          // PRIVATE, NEUTRAL cwd per seat — two separate necessities:
          // • Neutral (never the repo): from inside the repo, `claude` loads
          //   the project context (.claude/, CLAUDE.md + wiki) and session init
          //   gets heavy enough that coga loses the tool-snapshot race.
          // • Private (never SHARED): the CLI persists per-project state keyed
          //   by cwd; N concurrent sessions in one cwd read-modify-write the
          //   same record, and late seats deterministically come up blind to
          //   their MCP server (observed: the 4th seat failed 10/10 fresh boots
          //   with a shared tmpdir() while seats 1-3 attached).
          cwd: botCwd,
        });

        // Wall-clock kill timer
        const killTimer = setTimeout(() => {
          proc.kill('SIGTERM');
        }, remaining);

        let timedOut = false;
        let mcpFailed = false;
        let limitHit = false;
        let sawCogaToolCall = false;
        let stdoutBuf = '';
        let sessionSeenFinished = false;
        let emittedModelRequest = false;

        proc.stdout?.on('data', (d: Buffer) => {
          stdoutBuf += d.toString();
          const lines = stdoutBuf.split('\n');
          stdoutBuf = lines.pop() ?? '';

          for (const line of lines) {
            if (!line.trim()) continue;

            const raw = tryParse(line) as Record<string, unknown> | undefined;
            if (!emittedModelRequest && raw?.type === 'system' && raw.subtype === 'init') {
              emittedModelRequest = true;
              // Boot is done — let the next seat start booting. NOTE: the init
              // line's mcp_servers status is NOT trustworthy as a kill signal:
              // it is emitted milliseconds before the connect completes (MCP
              // debug logs show ~300ms connects on sessions whose init said
              // "pending"), so acting on it kills healthy sessions. The real
              // toolless-session detection is behavioral, on close (below).
              releaseBootOnce();

              // On the first system:init, emit a model_request event carrying
              // the model and a representation of the prompt.
              onEvent({
                t: Date.now(),
                bot: botName,
                kind: 'model_request',
                model: cliModel,
                messages: [{ role: 'user', content: prompt }],
              });
            }

            const { events, seenFinished } = parseStreamLine(line, botName, cliModel);
            for (const ev of events) {
              if (ev.kind === 'tool_call' && ev.name.startsWith('mcp__coga')) {
                sawCogaToolCall = true;
              }
              // Subscription usage cap ("You've hit your session limit ·
              // resets 3:30pm"): NOT a boot failure — retrying burns nothing
              // but produces junk unfinished runs marked ok (observed: a 12-run
              // sweep of empty games, 2026-07-03). Fail the seat loudly.
              if (
                ev.kind === 'model_response' &&
                typeof ev.text === 'string' &&
                /hit your (session|usage) limit/i.test(ev.text)
              ) {
                limitHit = true;
              }
              onEvent(ev);
            }
            if (seenFinished) sessionSeenFinished = true;
          }
        });

        proc.stderr?.on('data', (d: Buffer) => {
          // Forward stderr lines as session:error detail (truncated) for debug
          const text = d.toString();
          for (const line of text.split('\n')) {
            const t = line.trim();
            if (t) {
              // Only emit at warn level — these are often verbose SDK logs
              process.stderr.write(`[${botName}!] ${t.slice(0, 200)}\n`);
            }
          }
        });

        proc.on('close', (_code, signal) => {
          clearTimeout(killTimer);
          releaseBootOnce();
          if (signal === 'SIGTERM') timedOut = true;
          // TOOLLESS-SESSION GUARD (behavioral). A session that ends on its own,
          // unfinished, without a single coga tool call was blind to the game —
          // its tool list was snapshotted before the MCP server connected (the
          // model typically states it has no coga tools and stops). One wasted
          // model call; runOnceGuarded retries with a FRESH session (a resumed
          // session keeps the frozen tool list, so resuming can never recover).
          if (!sessionSeenFinished && !timedOut && !sawCogaToolCall && !limitHit) mcpFailed = true;
          resolve({ seenFinished: sessionSeenFinished, timedOut, mcpFailed, limitHit });
        });

        proc.on('error', (err) => {
          clearTimeout(killTimer);
          releaseBootOnce();
          reject(err);
        });
      });
    };

    /**
     * runOnce + MCP attach retries. On a failed attach (coga not "connected"
     * at the init snapshot — see the guard in runOnce) the subprocess was
     * killed before any turn ran; respawn with a FRESH session id (the dead
     * session's tool list is frozen without coga forever) and linear backoff
     * so a cold/contended coga start gets time to warm. Resume attempts keep
     * their session id — the game progress lives in that session.
     */
    const MCP_ATTACH_RETRIES = 10;
    const runOnceGuarded = async (
      prompt: string,
      isResume: boolean,
    ): Promise<{ seenFinished: boolean; timedOut: boolean }> => {
      for (let attempt = 0; attempt < MCP_ATTACH_RETRIES; attempt++) {
        const result = await runOnce(prompt, isResume);
        if (result.limitHit) {
          throw new Error(
            'Claude subscription usage limit reached — seat aborted (the model replied "You\'ve hit your session limit"). Re-run after the limit window resets.',
          );
        }
        if (!result.mcpFailed) return result;
        if (!isResume) sessionId = randomUUID();
        onEvent({
          t: Date.now(),
          bot: botName,
          kind: 'session',
          event: 'start',
          detail: `mcp attach retry ${attempt + 1}`,
        });
        // Failed boots cost no tokens (killed at init) — retry briskly, capped.
        await new Promise((r) => setTimeout(r, Math.min(5000, 1500 * (attempt + 1))));
      }
      throw new Error(`coga MCP server failed to attach after ${MCP_ATTACH_RETRIES} attempts`);
    };

    // -----------------------------------------------------------------------
    // Resume loop — mirrors the original MAX_RESUMES pattern, but capped by
    // limits.maxModelCalls across all sessions.
    // -----------------------------------------------------------------------

    // Each call to claude --print is "one model call session"; the internal
    // --max-turns 50 means up to 50 turns per subprocess. We track invocations
    // here as the "model call" unit (matching the original MAX_RESUMES intent).
    // TODO: if a finer-grained call count (per-turn) is needed, parse the
    // `result` lines' turn counts from the stream-json output.

    // Floor of 2: a seat must survive one bad subprocess session. MCP startup
    // can race the session's tool-list snapshot (server "pending" at init →
    // model sees zero coga tools); Claude-5-family models then decline to play
    // and end the session. The resume respawns coga (now warm) and recovers.
    // With maxModelCalls < 50 the old formula gave maxSessions=1 — no retry —
    // which killed such seats outright (observed 2026-07-03, sonnet-5).
    const baseMaxSessions = Math.max(2, Math.ceil(limits.maxModelCalls / 50));
    // Rotation shortens each subprocess's turn budget, so it needs more of
    // them to reach the same maxModelCalls — scale up, never down (+2 slack
    // for the boot-verify session and one MCP-attach retry).
    const maxSessions = rotationEnabled
      ? Math.max(
          baseMaxSessions,
          Math.ceil(limits.maxModelCalls / (rotateAfterTurns as number)) + 2,
        )
      : baseMaxSessions;

    // Build the initial prompt: system prompt prepended to the protocol prompt
    // (the claude --print CLI has no separate --system flag for non-interactive
    // use; prepending is the proven approach from bot-agent.ts).
    const initialPrompt = `${systemPrompt}\n\n${BASE_PROTOCOL_PROMPT(botName)}`;

    try {
      // Phase 1 — boot-verify: a trivial guide call that proves this session
      // sees the coga tools. Blind boots (tool list snapshotted pre-connect)
      // fail the toolless guard in ~seconds and are respawned fresh by
      // runOnceGuarded, so gameplay never starts in a blind session.
      const boot = await runOnceGuarded(BOOT_VERIFY_PROMPT, false);
      totalModelCalls++;
      if (boot.timedOut) {
        onEvent({
          t: Date.now(),
          bot: botName,
          kind: 'session',
          event: 'cap',
          detail: `wall-clock limit ${limits.wallClockMs}ms exceeded during boot-verify`,
        });
        return { finished: false, modelCalls: totalModelCalls, reason: 'cap' };
      }

      // Phase 2 — gameplay, resumed into the verified session.
      let { seenFinished, timedOut } = await runOnceGuarded(initialPrompt, true);
      totalModelCalls++;

      if (seenFinished) finished = true;

      let rotationCount = 0;
      for (let i = 1; i < maxSessions && !finished && !timedOut && Date.now() < deadline; i++) {
        if (totalModelCalls >= limits.maxModelCalls) break;

        // Every iteration reached here follows a HEALTHY unfinished exit —
        // runOnceGuarded already retried away any dead-MCP-attach session,
        // and a timedOut result breaks the loop condition above — so with
        // rotation on, always rotate (never --resume the accumulated
        // conversation). Flag off: byte-identical to the old resume loop.
        let result: { seenFinished: boolean; timedOut: boolean };
        if (rotationEnabled) {
          rotationCount++;
          sessionId = randomUUID(); // fresh session — drop the old conversation
          onEvent({
            t: Date.now(),
            bot: botName,
            kind: 'session',
            event: 'start',
            detail: `rotation ${rotationCount}`,
          });
          const rejoinPrompt = `${systemPrompt}\n\n${REJOIN_PROMPT(botName)}`;
          result = await runOnceGuarded(rejoinPrompt, false);
        } else {
          onEvent({
            t: Date.now(),
            bot: botName,
            kind: 'session',
            event: 'start',
            detail: `resume ${i}`,
          });
          result = await runOnceGuarded(RESUME_PROMPT, true);
        }
        timedOut = result.timedOut;
        totalModelCalls++;

        if (result.seenFinished) {
          finished = true;
        }
      }

      if (finished) {
        onEvent({ t: Date.now(), bot: botName, kind: 'session', event: 'finished' });
        return { finished: true, modelCalls: totalModelCalls, reason: 'finished' };
      }

      if (Date.now() >= deadline || totalModelCalls >= limits.maxModelCalls) {
        const detail =
          Date.now() >= deadline
            ? `wall-clock limit ${limits.wallClockMs}ms exceeded`
            : `model call cap ${limits.maxModelCalls} reached`;
        onEvent({ t: Date.now(), bot: botName, kind: 'session', event: 'cap', detail });
        return { finished: false, modelCalls: totalModelCalls, reason: 'cap' };
      }

      onEvent({
        t: Date.now(),
        bot: botName,
        kind: 'session',
        event: 'cap',
        detail: 'session loop exhausted',
      });
      return { finished: false, modelCalls: totalModelCalls, reason: 'cap' };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      onEvent({ t: Date.now(), bot: botName, kind: 'session', event: 'error', detail });
      // Also surface the reason on stdout — supervisors (Campaign Console)
      // only see this stream, and a usage-limit hit should read as a sentence
      // there, not as a bare nonzero exit.
      console.error(`  [${botName}] session error: ${detail.slice(0, 300)}`);
      return { finished: false, modelCalls: totalModelCalls, reason: 'error' };
    }
  }
}
