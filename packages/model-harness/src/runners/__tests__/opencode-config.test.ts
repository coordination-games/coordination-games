import { describe, expect, it } from 'vitest';
import {
  buildOpenCodeArgs,
  buildOpenCodeConfig,
  buildOpenCodeEnvironment,
  OPENCODE_GAME_AGENT,
} from '../opencode-config.js';

describe('OpenCode CLI launch configuration', () => {
  it('Given a first and resumed request, when building argv, then it uses direct exact-model arguments and an explicit session', () => {
    const initial = buildOpenCodeArgs({
      model: 'minimax-coding-plan/MiniMax-M3',
      prompt: 'begin',
      runtimeDirectory: '/tmp/game-seat',
      variant: 'none',
    });
    const resumed = buildOpenCodeArgs({
      model: 'minimax-coding-plan/MiniMax-M3',
      prompt: 'continue',
      runtimeDirectory: '/tmp/game-seat',
      sessionId: 'ses_test',
      variant: 'none',
    });

    expect(initial).toEqual([
      'run',
      '--pure',
      '--model',
      'minimax-coding-plan/MiniMax-M3',
      '--agent',
      OPENCODE_GAME_AGENT,
      '--variant',
      'none',
      '--format',
      'json',
      '--dir',
      '/tmp/game-seat',
      'begin',
    ]);
    expect(resumed).toEqual([...initial.slice(0, -1), '--session', 'ses_test', 'continue']);
  });

  it('Given one seat identity, when building inline config, then only coga is enabled and every unrelated tool is denied', () => {
    const config = buildOpenCodeConfig({
      coga: { command: 'npx', args: ['coga', 'serve', '--key', 'ephemeral-seat-key'] },
      cogaWorkingDirectory: '/repo',
      model: 'minimax-coding-plan/MiniMax-M3',
      systemPrompt: 'game persona',
      maxModelCalls: 7,
      disablePlugins: ['trust'],
    });

    expect(config).toMatchObject({
      share: 'disabled',
      snapshot: false,
      enabled_providers: ['minimax-coding-plan'],
      tools: { '*': false, 'coga_*': true },
      mcp: {
        coga: {
          type: 'local',
          command: ['npx', 'coga', 'serve', '--key', 'ephemeral-seat-key'],
          cwd: '/repo',
          enabled: true,
          environment: { COGA_DISABLE_PLUGINS: 'trust' },
        },
      },
      agent: {
        [OPENCODE_GAME_AGENT]: {
          mode: 'primary',
          model: 'minimax-coding-plan/MiniMax-M3',
          prompt: 'game persona',
          steps: 7,
          tools: { '*': false, 'coga_*': true },
          permission: { '*': 'deny', 'coga_*': 'allow' },
        },
      },
    });
    expect(JSON.stringify(config)).not.toMatch(/baseUrl|apiKey|pricing|webfetch|bash|task/);
  });

  it('Given inherited direct-API and config overrides, when building the child environment, then it keeps stored-auth discovery but removes rerouting and billing inputs', () => {
    const environment = buildOpenCodeEnvironment({
      config: { agent: {} },
      outputTokenCap: 1024,
      baseEnvironment: {
        HOME: '/home/test',
        PATH: '/bin',
        MINIMAX_API_KEY: 'direct-billing-test-value',
        OPENROUTER_API_KEY: 'direct-billing-test-value',
        OPENCODE_CONFIG: '/unsafe/config.json',
        OPENCODE_CONFIG_DIR: '/unsafe/config-dir',
        OPENCODE_PERMISSION: '{"*":"allow"}',
      },
    });

    expect(environment.HOME).toBe('/home/test');
    expect(environment.PATH).toBe('/bin');
    expect(environment.OPENCODE_CONFIG_CONTENT).toBe('{"agent":{}}');
    expect(environment.OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX).toBe('1024');
    expect(environment.OPENCODE_DISABLE_PROJECT_CONFIG).toBe('1');
    expect(environment.OPENCODE_DISABLE_CLAUDE_CODE).toBe('1');
    expect(environment.OPENCODE_DISABLE_DEFAULT_PLUGINS).toBe('1');
    expect(environment.MINIMAX_API_KEY).toBeUndefined();
    expect(environment.OPENROUTER_API_KEY).toBeUndefined();
    expect(environment.OPENCODE_CONFIG).toBeUndefined();
    expect(environment.OPENCODE_CONFIG_DIR).toBeUndefined();
    expect(environment.OPENCODE_PERMISSION).toBeUndefined();
  });
});
