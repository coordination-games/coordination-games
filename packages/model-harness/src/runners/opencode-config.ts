import type { CogaServeInvocation } from '../coga-client.js';

export const OPENCODE_GAME_AGENT = 'coga-game';

const removedEnvironmentKeys = [
  'ANTHROPIC_API_KEY',
  'MINIMAX_API_KEY',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'OPENCODE_CONFIG',
  'OPENCODE_CONFIG_DIR',
  'OPENCODE_ENABLE_EXA',
  'OPENCODE_MODELS_URL',
  'OPENCODE_PERMISSION',
] as const;

export function buildOpenCodeArgs(input: {
  readonly model: string;
  readonly prompt: string;
  readonly runtimeDirectory: string;
  readonly sessionId?: string;
  readonly variant?: string;
}): string[] {
  return [
    'run',
    '--pure',
    '--model',
    input.model,
    '--agent',
    OPENCODE_GAME_AGENT,
    ...(input.variant ? ['--variant', input.variant] : []),
    '--format',
    'json',
    '--dir',
    input.runtimeDirectory,
    ...(input.sessionId ? ['--session', input.sessionId] : []),
    input.prompt,
  ];
}

export function buildOpenCodeConfig(input: {
  readonly coga: CogaServeInvocation;
  readonly cogaWorkingDirectory: string;
  readonly model: string;
  readonly systemPrompt: string;
  readonly maxModelCalls: number;
  readonly disablePlugins?: readonly string[];
}): Record<string, unknown> {
  const providerId = input.model.slice(0, input.model.indexOf('/'));
  const toolPolicy = { '*': false, 'coga_*': true };
  const permission = { '*': 'deny', 'coga_*': 'allow' };
  return {
    share: 'disabled',
    snapshot: false,
    autoupdate: false,
    enabled_providers: [providerId],
    instructions: [],
    lsp: false,
    formatter: false,
    tools: toolPolicy,
    mcp: {
      coga: {
        type: 'local',
        command: [input.coga.command, ...input.coga.args],
        cwd: input.cogaWorkingDirectory,
        enabled: true,
        ...(input.disablePlugins?.length
          ? { environment: { COGA_DISABLE_PLUGINS: input.disablePlugins.join(',') } }
          : {}),
      },
    },
    agent: {
      [OPENCODE_GAME_AGENT]: {
        description: 'Restricted Coordination Games seat agent',
        mode: 'primary',
        model: input.model,
        prompt: input.systemPrompt,
        steps: input.maxModelCalls,
        tools: toolPolicy,
        permission,
      },
    },
  };
}

export function buildOpenCodeEnvironment(input: {
  readonly config: Record<string, unknown>;
  readonly outputTokenCap: number;
  readonly baseEnvironment: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  const environment = { ...input.baseEnvironment };
  for (const key of removedEnvironmentKeys) delete environment[key];
  environment.OPENCODE_CONFIG_CONTENT = JSON.stringify(input.config);
  environment.OPENCODE_DISABLE_PROJECT_CONFIG = '1';
  environment.OPENCODE_DISABLE_CLAUDE_CODE = '1';
  environment.OPENCODE_DISABLE_DEFAULT_PLUGINS = '1';
  environment.OPENCODE_DISABLE_EXTERNAL_SKILLS = '1';
  environment.OPENCODE_DISABLE_LSP_DOWNLOAD = '1';
  environment.OPENCODE_AUTO_SHARE = '0';
  environment.OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX = String(input.outputTokenCap);
  return environment;
}
