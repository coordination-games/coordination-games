/**
 * OpenRouterAgentRunner — the new, model-generic brain (blueprint §4.3).
 *
 * A standard MCP stdio client + an OpenAI-style native function-calling loop:
 *
 *   1. Spawn `coga serve --stdio ...` (via cogaServeCommand) and connect with the
 *      MCP SDK `Client` over `StdioClientTransport`.
 *   2. `listTools()` → map each MCP tool to OpenAI tools format. NO hardcoded
 *      schemas — this is what keeps the runner game-generic.
 *   3. Seed messages with the assembled system prompt + a first user nudge.
 *   4. Loop, bounded by maxModelCalls / wallClockMs:
 *        - POST OpenRouter /chat/completions with { model, messages, tools,
 *          tool_choice:'auto' }.  Emit model_request / model_response events.
 *        - For each returned tool_call: callTool on the MCP client, append a
 *          {role:'tool'} message, emit tool_call + tool_result events. A result
 *          whose text contains `"phase":"finished"` ends the session.
 *        - If the assistant returned content but NO tool_calls, append a system
 *          nudge and continue.
 *   5. On finish / cap / error: close the MCP client (which terminates the
 *      subprocess) and return SessionResult.
 *
 * Credentials: OPENROUTER_API_KEY (or OPENAI_API_KEY). Base URL defaults to
 * https://openrouter.ai/api/v1, overridable via OPENAI_BASE_URL (MiniMax direct,
 * etc.). The `openrouter/` model-id prefix is stripped before sending; the rest
 * of the id is passed through as the provider expects.
 *
 * Context stays lean for free: `state` tool results come from the real
 * GameClient → AgentStateDiffer, so each is a deduped delta, and `newMessages`
 * is relay-cursor-filtered (wiki/architecture/agent-envelope.md).
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { cogaServeCommand } from '../coga-client.js';
import type { AgentRunner, RunSessionOptions, SessionResult, ToolResultEvent } from '../types.js';

// ---------------------------------------------------------------------------
// OpenAI / OpenRouter wire shapes (only what we read/write — defensive).
// ---------------------------------------------------------------------------

interface OpenAiTool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

interface OpenAiToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

/** A message in the OpenAI chat array. We keep it loose — providers differ. */
interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: OpenAiToolCall[];
  tool_call_id?: string;
  name?: string;
}

// A minimal "empty object" JSON schema for tools that advertise no inputSchema.
const EMPTY_SCHEMA: Record<string, unknown> = { type: 'object', properties: {} };

export class OpenRouterAgentRunner implements AgentRunner {
  async runSession(opts: RunSessionOptions): Promise<SessionResult> {
    const { botName, privateKey, server, systemPrompt, model, limits, onEvent, disablePlugins } =
      opts;
    const startedAt = Date.now();
    const deadline = startedAt + limits.wallClockMs;

    const apiKey = process.env.OPENROUTER_API_KEY ?? process.env.OPENAI_API_KEY;
    const baseUrl = (process.env.OPENAI_BASE_URL ?? 'https://openrouter.ai/api/v1').replace(
      /\/+$/,
      '',
    );
    // Strip any `openrouter/` routing prefix — that prefix is for the harness's
    // backend-selection, not part of the provider's model id.
    const wireModel = model.replace(/^openrouter\//, '');

    onEvent({ t: Date.now(), bot: botName, kind: 'session', event: 'start', detail: model });

    if (!apiKey) {
      const detail = 'OPENROUTER_API_KEY (or OPENAI_API_KEY) is not set';
      onEvent({ t: Date.now(), bot: botName, kind: 'session', event: 'error', detail });
      return { finished: false, modelCalls: 0, reason: 'error' };
    }

    // --- Connect to the single integration point: coga serve --stdio. --------
    const coga = cogaServeCommand(privateKey, botName, server);
    const transport = new StdioClientTransport({
      command: coga.command,
      args: coga.args,
      // Inherit the parent env so PATH (global npm bin) and any creds resolve;
      // the SDK's default env strips most vars, which breaks `npx`/`coga`. The
      // COGA_DISABLE_PLUGINS denylist (if any) rides along so the spawned coga's
      // client-side pipeline drops the named plugins.
      env: inheritedEnv(disablePlugins),
      stderr: 'inherit',
    });
    const client = new Client(
      { name: 'coga-harness-openrouter', version: '0.1.0' },
      { capabilities: {} },
    );

    let modelCalls = 0;
    let finished = false;
    let reason: SessionResult['reason'] = 'error';

    try {
      await client.connect(transport);

      // --- Map MCP tools → OpenAI tools format. No hardcoded schemas. --------
      const listed = await client.listTools();
      const tools: OpenAiTool[] = (listed.tools ?? []).map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          // OpenAI rejects an undefined description key under strict providers.
          ...(tool.description ? { description: tool.description } : {}),
          parameters: (tool.inputSchema as Record<string, unknown> | undefined) ?? EMPTY_SCHEMA,
        },
      }));

      // --- Seed the conversation. -------------------------------------------
      const messages: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: 'You are joined to an active lobby. Begin: call guide, then state.',
        },
      ];

      // --- The loop. --------------------------------------------------------
      while (true) {
        if (Date.now() >= deadline) {
          reason = 'cap';
          onEvent({
            t: Date.now(),
            bot: botName,
            kind: 'session',
            event: 'cap',
            detail: 'wallClockMs exceeded',
          });
          break;
        }
        if (modelCalls >= limits.maxModelCalls) {
          reason = 'cap';
          onEvent({
            t: Date.now(),
            bot: botName,
            kind: 'session',
            event: 'cap',
            detail: `maxModelCalls (${limits.maxModelCalls}) reached`,
          });
          break;
        }

        // ---- Model call ----
        onEvent({
          t: Date.now(),
          bot: botName,
          kind: 'model_request',
          model: wireModel,
          messages,
        });
        modelCalls += 1;

        const assistant = await this.callModel({
          baseUrl,
          apiKey,
          model: wireModel,
          messages,
          tools,
          botName,
        });

        const text = assistant.content ?? undefined;
        const toolCalls = assistant.tool_calls ?? [];

        onEvent({
          t: Date.now(),
          bot: botName,
          kind: 'model_response',
          ...(text !== undefined ? { text } : {}),
          ...(toolCalls.length > 0
            ? {
                toolCalls: toolCalls.map((tc) => ({
                  name: tc.function?.name ?? '',
                  args: safeParseArgs(tc.function?.arguments),
                })),
              }
            : {}),
          ...(assistant.usage !== undefined ? { usage: assistant.usage } : {}),
        });

        // The assistant message must go into the history verbatim (OpenAI
        // requires the assistant turn that issued tool_calls to precede the
        // matching tool results).
        messages.push({
          role: 'assistant',
          content: text ?? null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        });

        // ---- No tool calls → nudge and continue. ----
        if (toolCalls.length === 0) {
          messages.push({
            role: 'system',
            content: 'Not over until phase:finished — call state/wait or a game action.',
          });
          continue;
        }

        // ---- Dispatch each tool call through the MCP client. ----
        for (const tc of toolCalls) {
          const name = tc.function?.name ?? '';
          const args = safeParseArgs(tc.function?.arguments);
          const toolCallId = tc.id ?? `${name}-${modelCalls}`;

          onEvent({ t: Date.now(), bot: botName, kind: 'tool_call', name, args });

          let resultText: string;
          let isError = false;
          let parsedResult: unknown;
          let stateVersion: number | undefined;
          let relayCursor: number | undefined;

          if (!name) {
            isError = true;
            resultText = JSON.stringify({ error: 'tool_call missing function name' });
            parsedResult = { error: 'tool_call missing function name' };
          } else {
            try {
              const result = await client.callTool({
                name,
                arguments: isRecord(args) ? args : {},
              });
              isError = result.isError === true;
              resultText = stringifyToolContent(result.content);
              parsedResult = tryParseJson(resultText);
              ({ stateVersion, relayCursor } = extractCursors(parsedResult));
            } catch (err) {
              isError = true;
              const msg = err instanceof Error ? err.message : String(err);
              resultText = JSON.stringify({ error: msg });
              parsedResult = { error: msg };
            }
          }

          const toolResultEvent: ToolResultEvent = {
            t: Date.now(),
            bot: botName,
            kind: 'tool_result',
            name,
            result: parsedResult,
            ...(isError ? { isError: true } : {}),
            ...(stateVersion !== undefined ? { stateVersion } : {}),
            ...(relayCursor !== undefined ? { relayCursor } : {}),
          };
          onEvent(toolResultEvent);

          // Feed the result back to the model.
          messages.push({
            role: 'tool',
            tool_call_id: toolCallId,
            name,
            content: resultText,
          });

          // Termination: a tool result that reports phase:"finished".
          if (looksFinished(resultText)) {
            finished = true;
          }
        }

        if (finished) {
          reason = 'finished';
          onEvent({ t: Date.now(), bot: botName, kind: 'session', event: 'finished' });
          break;
        }
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      reason = 'error';
      onEvent({ t: Date.now(), bot: botName, kind: 'session', event: 'error', detail });
    } finally {
      // Closing the client closes the transport, which terminates the spawned
      // `npx coga serve` subprocess. Kill defensively if the pid lingers.
      const pid = transport.pid;
      try {
        await client.close();
      } catch {
        // ignore — best-effort teardown
      }
      try {
        await transport.close();
      } catch {
        // ignore — best-effort teardown
      }
      if (pid != null) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // already gone — fine
        }
      }
    }

    return { finished, modelCalls, reason };
  }

  /**
   * One POST to the OpenAI-compatible /chat/completions endpoint. Defensive
   * about response shape across OpenRouter / direct providers. Returns the
   * assistant message plus usage (if present).
   */
  private async callModel(args: {
    baseUrl: string;
    apiKey: string;
    model: string;
    messages: ChatMessage[];
    tools: OpenAiTool[];
    botName: string;
  }): Promise<{ content: string | null; tool_calls?: OpenAiToolCall[]; usage?: unknown }> {
    const { baseUrl, apiKey, model, messages, tools, botName } = args;

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        // OpenRouter attribution headers — harmless against other providers.
        'HTTP-Referer': 'https://games.coop',
        'X-Title': 'Coordination Games Harness',
      },
      body: JSON.stringify({
        model,
        messages,
        // Send tools only when present; some providers 400 on an empty array.
        ...(tools.length > 0 ? { tools, tool_choice: 'auto' } : {}),
      }),
    });

    const bodyText = await res.text();
    if (!res.ok) {
      throw new Error(
        `OpenRouter HTTP ${res.status} for ${botName} (${model}): ${bodyText.slice(0, 500)}`,
      );
    }

    let body: unknown;
    try {
      body = JSON.parse(bodyText) as unknown;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        `OpenRouter returned non-JSON for ${botName} (${model}): ${detail}; body=${bodyText.slice(0, 500)}`,
      );
    }

    // Defensive extraction: choices[0].message.{content, tool_calls}.
    const choices = isRecord(body) && Array.isArray(body.choices) ? body.choices : [];
    const choice = choices.length > 0 ? choices[0] : undefined;
    const message = isRecord(choice) && isRecord(choice.message) ? choice.message : undefined;

    const content = message && typeof message.content === 'string' ? message.content : null;
    const rawToolCalls =
      message && Array.isArray(message.tool_calls) ? message.tool_calls : undefined;
    const tool_calls = rawToolCalls
      ?.map(normalizeToolCall)
      .filter((tc): tc is OpenAiToolCall => tc !== undefined);

    const usage = isRecord(body) ? body.usage : undefined;

    return {
      content,
      ...(tool_calls && tool_calls.length > 0 ? { tool_calls } : {}),
      ...(usage !== undefined ? { usage } : {}),
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Coerce a raw provider tool_call into our shape, dropping anything unusable. */
function normalizeToolCall(raw: unknown): OpenAiToolCall | undefined {
  if (!isRecord(raw)) return undefined;
  const fn = isRecord(raw.function) ? raw.function : undefined;
  const name = fn && typeof fn.name === 'string' ? fn.name : undefined;
  // A tool_call with no function name is unusable — drop it.
  if (!name) return undefined;
  const argsStr =
    fn && typeof fn.arguments === 'string'
      ? fn.arguments
      : fn && fn.arguments !== undefined
        ? // Some providers hand back an already-parsed object — re-stringify so
          // our downstream `JSON.parse` round-trips uniformly.
          JSON.stringify(fn.arguments)
        : '{}';
  return {
    ...(typeof raw.id === 'string' ? { id: raw.id } : {}),
    type: 'function',
    function: { name, arguments: argsStr },
  };
}

/** Parse a tool_call's `arguments` string into an object; tolerate junk. */
function safeParseArgs(argsStr: string | undefined): unknown {
  if (argsStr === undefined || argsStr === '') return {};
  const parsed = tryParseJson(argsStr);
  // Models sometimes emit `arguments: "{}"` correctly but occasionally wrap in
  // prose. If parsing fails, surface the raw string so it lands in the
  // transcript rather than silently becoming `{}`.
  return parsed === undefined ? { _rawArguments: argsStr } : parsed;
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Flatten an MCP CallTool result's `content` blocks into a single string. We
 * only care about text here; image/audio/resource blocks are summarized.
 */
function stringifyToolContent(content: unknown): string {
  if (!Array.isArray(content)) {
    return typeof content === 'string' ? content : JSON.stringify(content ?? {});
  }
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) {
      parts.push(JSON.stringify(block));
      continue;
    }
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    } else if (block.type === 'resource' && isRecord(block.resource)) {
      const r = block.resource;
      parts.push(typeof r.text === 'string' ? r.text : JSON.stringify(r));
    } else {
      // image / audio / unknown — keep a compact marker, not the raw blob.
      parts.push(JSON.stringify({ type: block.type ?? 'unknown' }));
    }
  }
  return parts.join('\n');
}

/** The done-signal: any tool result whose text reports phase:"finished". */
function looksFinished(text: string): boolean {
  // Tolerate whitespace variations: "phase":"finished" / "phase": "finished".
  return /"phase"\s*:\s*"finished"/.test(text);
}

/**
 * Consequential-action derivation (§9): pull the canonical state version and
 * relay cursor out of a parsed tool result if present. Shapes vary by tool, so
 * probe the common envelope locations defensively.
 */
function extractCursors(result: unknown): {
  stateVersion: number | undefined;
  relayCursor: number | undefined;
} {
  let stateVersion: number | undefined;
  let relayCursor: number | undefined;
  if (isRecord(result)) {
    // State version: knownStateVersion / stateVersion at top level or under meta.
    stateVersion =
      numAt(result, 'knownStateVersion') ??
      numAt(result, 'stateVersion') ??
      (isRecord(result.meta)
        ? (numAt(result.meta, 'knownStateVersion') ?? numAt(result.meta, 'stateVersion'))
        : undefined);
    // Relay cursor: meta.sinceIdx (the relay cursor split, see relay-and-cursor.md).
    relayCursor = isRecord(result.meta)
      ? numAt(result.meta, 'sinceIdx')
      : numAt(result, 'sinceIdx');
  }
  return { stateVersion, relayCursor };
}

function numAt(obj: Record<string, unknown>, key: string): number | undefined {
  const v = obj[key];
  return typeof v === 'number' ? v : undefined;
}

/**
 * Build the env for the spawned `coga serve` subprocess. We forward the parent
 * env (so PATH, HOME, and any creds resolve), dropping undefined values so it
 * satisfies `Record<string, string>`. The optional `disablePlugins` denylist is
 * passed through as COGA_DISABLE_PLUGINS so the spawned coga's client-side
 * pipeline drops the named plugins (per-agent ablation knob).
 */
function inheritedEnv(disablePlugins?: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') out[k] = v;
  }
  if (disablePlugins && disablePlugins.length > 0) {
    out.COGA_DISABLE_PLUGINS = disablePlugins.join(',');
  }
  return out;
}
