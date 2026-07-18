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
import { cogaServeCommand } from '../coga-client.js';
import { BASE_PROTOCOL_PROMPT, RESUME_PROMPT } from '../prompts.js';
import type { AgentRunner, RunSessionOptions, SessionResult } from '../types.js';
import { claudeCliModel } from '../types.js';
import { budgetFailure } from './budget-guard.js';
import { parseStreamLine, tryParse } from './claude-stream.js';

// ---------------------------------------------------------------------------
// ClaudeAgentRunner
// ---------------------------------------------------------------------------

export class ClaudeAgentRunner implements AgentRunner {
  async runSession(opts: RunSessionOptions): Promise<SessionResult> {
    const { botName, privateKey, server, systemPrompt, model, limits, onEvent, disablePlugins } =
      opts;
    // The seat model may carry a backend-routing prefix (`anthropic/claude-haiku`)
    // or a friendly tier alias the `claude` CLI doesn't accept raw — normalize to
    // a CLI-valid `--model` value. The original seat model stays in the manifest.
    const cliModel = claudeCliModel(model);

    const sessionId = randomUUID();
    const deadline = Date.now() + limits.wallClockMs;

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
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
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
          cliModel,
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
          env: childEnv,
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
                model: cliModel,
                messages: [{ role: 'user', content: prompt }],
              });
            }

            const { events, seenFinished } = parseStreamLine(line, botName);
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
      const beforeInitialRequest = budgetFailure(opts, totalModelCalls);
      if (beforeInitialRequest) return beforeInitialRequest;
      let { seenFinished, timedOut } = await runOnce(initialPrompt, false);
      totalModelCalls++;

      if (seenFinished) finished = true;

      for (let i = 1; i < maxSessions && !finished && !timedOut && Date.now() < deadline; i++) {
        if (totalModelCalls >= limits.maxModelCalls) break;
        const beforeResumeRequest = budgetFailure(opts, totalModelCalls);
        if (beforeResumeRequest) return beforeResumeRequest;

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
