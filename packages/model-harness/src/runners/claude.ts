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
 *  6. MCP config is built with cogaServeArgs() so both backends share exactly
 *     the same coga serve invocation.
 *
 * MUST NOT set ANTHROPIC_API_KEY — local ~/.claude creds only.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cogaServeArgs } from '../coga-client.js';
import { BASE_PROTOCOL_PROMPT, RESUME_PROMPT } from '../prompts.js';
import type { AgentRunner, RunSessionOptions, SessionResult, TranscriptEvent } from '../types.js';

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
    const { botName, privateKey, server, systemPrompt, model, limits, onEvent } = opts;

    const sessionId = randomUUID();
    const deadline = Date.now() + limits.wallClockMs;

    const mcpConfig = JSON.stringify({
      mcpServers: {
        coga: {
          command: 'npx',
          args: cogaServeArgs(privateKey, botName, server),
        },
      },
    });

    let totalModelCalls = 0;
    let finished = false;

    // Emit session start
    onEvent({ t: Date.now(), bot: botName, kind: 'session', event: 'start' });

    /**
     * Run one `claude --print` subprocess and return the accumulated raw
     * stdout (needed for the looksFinished fallback). Emits TranscriptEvents
     * as lines arrive.
     */
    const runOnce = (
      prompt: string,
      isResume: boolean,
    ): Promise<{ seenFinished: boolean; timedOut: boolean }> => {
      return new Promise((resolve, reject) => {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          resolve({ seenFinished: false, timedOut: true });
          return;
        }

        const args: string[] = [
          '--print',
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
          env: { ...process.env },
        });

        // Wall-clock kill timer
        const killTimer = setTimeout(() => {
          proc.kill('SIGTERM');
        }, remaining);

        let timedOut = false;
        let stdoutBuf = '';
        let sessionSeenFinished = false;
        let emittedModelRequest = false;

        proc.stdout?.on('data', (d: Buffer) => {
          stdoutBuf += d.toString();
          const lines = stdoutBuf.split('\n');
          stdoutBuf = lines.pop() ?? '';

          for (const line of lines) {
            if (!line.trim()) continue;

            // On the first system:init, emit a model_request event carrying
            // the model and a representation of the prompt as the messages.
            const raw = tryParse(line) as Record<string, unknown> | undefined;
            if (!emittedModelRequest && raw?.type === 'system' && raw.subtype === 'init') {
              emittedModelRequest = true;
              onEvent({
                t: Date.now(),
                bot: botName,
                kind: 'model_request',
                model,
                messages: [{ role: 'user', content: prompt }],
              });
            }

            const { events, seenFinished } = parseStreamLine(line, botName, model);
            for (const ev of events) onEvent(ev);
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
          if (signal === 'SIGTERM') timedOut = true;
          resolve({ seenFinished: sessionSeenFinished, timedOut });
        });

        proc.on('error', (err) => {
          clearTimeout(killTimer);
          reject(err);
        });
      });
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

    const maxSessions = Math.ceil(limits.maxModelCalls / 50); // conservative

    // Build the initial prompt: system prompt prepended to the protocol prompt
    // (the claude --print CLI has no separate --system flag for non-interactive
    // use; prepending is the proven approach from bot-agent.ts).
    const initialPrompt = `${systemPrompt}\n\n${BASE_PROTOCOL_PROMPT(botName)}`;

    try {
      let { seenFinished, timedOut } = await runOnce(initialPrompt, false);
      totalModelCalls++;

      if (seenFinished) finished = true;

      for (let i = 1; i < maxSessions && !finished && !timedOut && Date.now() < deadline; i++) {
        if (totalModelCalls >= limits.maxModelCalls) break;

        onEvent({
          t: Date.now(),
          bot: botName,
          kind: 'session',
          event: 'start',
          detail: `resume ${i}`,
        });

        const result = await runOnce(RESUME_PROMPT, true);
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
      return { finished: false, modelCalls: totalModelCalls, reason: 'error' };
    }
  }
}
