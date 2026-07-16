import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { cogaServeCommand } from '../coga-client.js';
import type { AgentRunner, RunSessionOptions, SessionResult } from '../types.js';
import { runOpenAiSession } from './openai-session.js';
import type { ToolClient } from './openai-tools.js';

export class OpenRouterAgentRunner implements AgentRunner {
  async runSession(options: RunSessionOptions): Promise<SessionResult> {
    const apiKey = process.env.OPENROUTER_API_KEY ?? process.env.OPENAI_API_KEY;
    const baseUrl = (process.env.OPENAI_BASE_URL ?? 'https://openrouter.ai/api/v1').replace(
      /\/+$/,
      '',
    );
    const command = cogaServeCommand(options.privateKey, options.botName, options.server);
    const transport = new StdioClientTransport({
      command: command.command,
      args: command.args,
      env: inheritedEnv(options.disablePlugins),
      stderr: 'inherit',
    });
    const client = new Client(
      { name: 'coga-harness-openrouter', version: '0.1.0' },
      { capabilities: {} },
    );
    try {
      await client.connect(transport);
      return await runOpenAiSession({ client: adaptClient(client), options, apiKey, baseUrl });
    } catch (error) {
      options.onEvent({
        t: Date.now(),
        bot: options.botName,
        kind: 'session',
        event: 'error',
        detail: error instanceof Error ? error.name : 'connection failure',
      });
      return { finished: false, modelCalls: 0, reason: 'error' };
    } finally {
      const pid = transport.pid;
      await closeQuietly(() => client.close());
      await closeQuietly(() => transport.close());
      if (pid != null) await closeQuietly(() => Promise.resolve(process.kill(pid, 'SIGKILL')));
    }
  }
}

function adaptClient(client: Client): ToolClient {
  return {
    async listTools() {
      const response = await client.listTools();
      return {
        tools: response.tools.map((tool) => ({
          name: tool.name,
          ...(tool.description !== undefined ? { description: tool.description } : {}),
          inputSchema: tool.inputSchema,
        })),
      };
    },
    async callTool(input) {
      const response = await client.callTool(input);
      if (!('content' in response)) throw new Error('MCP tool response omitted content');
      return {
        content: response.content,
        ...(response.isError === true ? { isError: true } : {}),
      };
    },
  };
}

async function closeQuietly(operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation();
  } catch {
    return;
  }
}

function inheritedEnv(disablePlugins?: string[]): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (typeof value === 'string') environment[key] = value;
  if (disablePlugins?.length) environment.COGA_DISABLE_PLUGINS = disablePlugins.join(',');
  return environment;
}
