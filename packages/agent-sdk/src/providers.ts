/**
 * LLM Provider abstraction — swap Anthropic, Minimax, OpenAI, etc.
 *
 * @example
 * import { LLMAgent, MinimaxProvider } from "@coordination-games/agent-sdk";
 *
 * const agent = new LLMAgent({
 *   provider: new MinimaxProvider(process.env.MINIMAX_API_KEY!),
 *   personaPath: "./personas/strategic.md",
 * });
 * agent.run();
 */

import OpenAI from "openai";
import type { ProviderTool } from "./types.js";

// ---------------------------------------------------------------------------
// Tool types (imported from types.ts)
// ---------------------------------------------------------------------------

export interface ToolCall {
  name: string;
  input: Record<string, unknown>;
}

export interface LLMResponse {
  toolCalls: ToolCall[];
  raw: unknown;
}

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

export interface LLMProviderOptions {
  maxTokens?: number;
}

export interface LLMProvider {
  /**
   * Send a completion request and extract tool calls from the response.
   * Returns an LLMResponse with at least one tool call, or throws.
   */
  complete(opts: {
    model: string;
    system: string;
    userMessage: string;
    tools: ProviderTool[];
  }): Promise<LLMResponse>;
}

// ---------------------------------------------------------------------------
// Anthropic provider (preserves existing LLMAgent behaviour)
// ---------------------------------------------------------------------------

export class AnthropicProvider implements LLMProvider {
  private apiKey: string;
  private maxTokens: number;

  constructor(apiKey: string, options: LLMProviderOptions = {}) {
    this.apiKey = apiKey;
    this.maxTokens = options.maxTokens ?? 1024;
  }

  async complete(opts: {
    model: string;
    system: string;
    userMessage: string;
    tools: ProviderTool[];
  }): Promise<LLMResponse> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const SDK = await import("@anthropic-ai/sdk") as any;
    const Anthropic = SDK.default ?? SDK;

    const client = new Anthropic({ apiKey: this.apiKey });

    // Map our ProviderTool format to Anthropic's tool format
    const anthropicTools = opts.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
    }));

    const message = await client.messages.create({
      model: opts.model,
      max_tokens: this.maxTokens,
      system: opts.system,
      tools: anthropicTools,
      tool_choice: { type: "any" },
      messages: [{ role: "user", content: opts.userMessage }],
    });

    const toolCalls: ToolCall[] = [];
    const contentBlocks = (message.content ?? []) as Array<{
      type?: string;
      name?: string;
      input?: Record<string, unknown>;
    }>;
    for (const block of contentBlocks) {
      if (block.type === "tool_use") {
        toolCalls.push({
          name: block.name ?? "",
          input: block.input ?? {},
        });
      }
    }

    return { toolCalls, raw: message };
  }
}

// ---------------------------------------------------------------------------
// Minimax provider — OpenAI-compatible API
// ---------------------------------------------------------------------------

export interface MinimaxProviderOptions extends LLMProviderOptions {
  /** Defaults to "https://api.minimax.chat/v1" */
  baseURL?: string;
}

export class MinimaxProvider implements LLMProvider {
  private apiKey: string;
  private baseURL: string;
  private maxTokens: number;

  constructor(apiKey: string, options: MinimaxProviderOptions = {}) {
    this.apiKey = apiKey;
    this.baseURL = options.baseURL ?? "https://api.minimax.chat/v1";
    this.maxTokens = options.maxTokens ?? 1024;
  }

  async complete(opts: {
    model: string;
    system: string;
    userMessage: string;
    tools: ProviderTool[];
  }): Promise<LLMResponse> {
    const client = new OpenAI({
      apiKey: this.apiKey,
      baseURL: this.baseURL,
      dangerouslyAllowBrowser: false,
    });

    // Map our ProviderTool format to OpenAI tool format
    const openaiTools = opts.tools.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema as {
          type: "object";
          properties: Record<string, unknown>;
          required?: string[];
        },
      },
    }));

    const message = await client.chat.completions.create({
      model: opts.model,
      max_tokens: this.maxTokens,
      temperature: 0.7,
      tools: openaiTools,
      tool_choice: "auto",
      messages: [
        { role: "system", content: opts.system },
        { role: "user", content: opts.userMessage },
      ],
    });

    const rawChoice = message.choices[0];
    if (!rawChoice) throw new Error("Minimax returned no choices");

    const toolCalls: ToolCall[] = [];
    const rawMessage = rawChoice.message as {
      tool_calls?: Array<{
        function?: { name?: string; arguments?: string };
      }>;
    };

    if (rawMessage.tool_calls) {
      for (const tc of rawMessage.tool_calls) {
        if (tc.function) {
          let input: Record<string, unknown> = {};
          try {
            if (tc.function.arguments) {
              input = JSON.parse(tc.function.arguments);
            }
          } catch {
            // use empty input on parse failure
          }
          toolCalls.push({
            name: tc.function.name ?? "",
            input,
          });
        }
      }
    }

    return { toolCalls, raw: message };
  }
}
