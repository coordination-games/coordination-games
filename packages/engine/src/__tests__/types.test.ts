import { describe, it, expect } from 'vitest';
import type {
  CoordinationGame,
  ToolPlugin,
  PluginMode,
  PluginContext,
  AgentInfo,
  ToolDefinition,
  LobbyPhase,
  PhaseContext,
  PhaseResult,
  GameLobbyConfig,
  LobbyPhaseConfig,
  MatchmakingConfig,
  Message,
  RelayClient,
  RelayAccess,
} from '../types.js';

describe('Type interfaces compile correctly', () => {
  it('ToolPlugin can be implemented', () => {
    const plugin: ToolPlugin = {
      id: 'test-plugin',
      version: '0.1.0',
      modes: [{ name: 'default', consumes: [], provides: ['test-data'] }],
      purity: 'pure',
      tools: [{
        name: 'test_tool',
        description: 'A test tool',
        inputSchema: { type: 'object', properties: { msg: { type: 'string' } } },
      }],
      handleData(mode: string, inputs: Map<string, any>) {
        return new Map([['test-data', { value: 42 }]]);
      },
      handleCall(tool: string, args: unknown, caller: AgentInfo) {
        return { ok: true };
      },
    };
    expect(plugin.id).toBe('test-plugin');
    expect(plugin.modes).toHaveLength(1);
    expect(plugin.purity).toBe('pure');
  });

  it('ToolPlugin with init() lifecycle', () => {
    const plugin: ToolPlugin = {
      id: 'stateful',
      version: '1.0.0',
      modes: [{ name: 'messaging', consumes: [], provides: ['messaging'] }],
      purity: 'stateful',
      init(ctx: PluginContext) {
        // access ctx fields
        const { gameType, gameId, turnCursor, relay, playerId } = ctx;
      },
      handleData(mode, inputs) {
        return new Map();
      },
    };
    expect(plugin.init).toBeDefined();
  });

  it('LobbyPhase can be implemented', async () => {
    const phase: LobbyPhase = {
      id: 'test-phase',
      name: 'Test Phase',
      timeout: 30,
      async run(ctx: PhaseContext): Promise<PhaseResult> {
        return {
          groups: [ctx.players],
          metadata: { completed: true },
        };
      },
    };
    expect(phase.id).toBe('test-phase');

    const result = await phase.run({
      players: [{ id: '1', handle: 'alice' }],
      gameConfig: {},
      relay: {
        send: () => {},
        broadcast: () => {},
        receive: () => [],
      },
      onTimeout: () => ({ groups: [], metadata: {} }),
    });
    expect(result.groups).toHaveLength(1);
    expect(result.metadata.completed).toBe(true);
  });

  it('GameLobbyConfig structures correctly', () => {
    const config: GameLobbyConfig = {
      queueType: 'open',
      phases: [
        { phaseId: 'team-formation', config: { rounds: 3 } },
        { phaseId: 'class-selection', config: {} },
      ],
      matchmaking: {
        minPlayers: 4,
        maxPlayers: 12,
        teamSize: 2,
        numTeams: 2,
        queueTimeoutMs: 120000,
      },
    };
    expect(config.phases).toHaveLength(2);
    expect(config.matchmaking.teamSize).toBe(2);
  });

  it('Message type with extensible tags', () => {
    const msg: Message = {
      from: 42,
      body: 'rush flag',
      turn: 3,
      scope: 'team',
      tags: { trust: 0.85, spam: false, source: 'basic-chat' },
    };
    expect(msg.tags.trust).toBe(0.85);
    expect(msg.scope).toBe('team');
  });

  it('CoordinationGame with lobby config', () => {
    // Type-check that CoordinationGame accepts lobby, requiredPlugins, recommendedPlugins
    const game: Partial<CoordinationGame<any, any, any, any>> = {
      gameType: 'test-game',
      version: '0.1.0',
      lobby: {
        queueType: 'open',
        phases: [],
        matchmaking: {
          minPlayers: 2,
          maxPlayers: 4,
          teamSize: 1,
          numTeams: 2,
          queueTimeoutMs: 60000,
        },
      },
      requiredPlugins: ['basic-chat'],
      recommendedPlugins: ['elo'],
    };
    expect(game.requiredPlugins).toContain('basic-chat');
    expect(game.lobby?.queueType).toBe('open');
  });

  it('PluginMode defines data flow', () => {
    const producer: PluginMode = { name: 'produce', consumes: [], provides: ['messaging'] };
    const mapper: PluginMode = { name: 'map', consumes: ['messaging'], provides: ['agents'] };
    const enricher: PluginMode = { name: 'enrich', consumes: ['agents'], provides: ['agent-tags'] };
    const filter: PluginMode = { name: 'filter', consumes: ['messaging', 'agent-tags'], provides: ['messaging'] };

    expect(producer.consumes).toHaveLength(0);
    expect(mapper.consumes).toContain('messaging');
    expect(enricher.provides).toContain('agent-tags');
    expect(filter.consumes).toHaveLength(2);
  });

  it('AgentInfo with optional team', () => {
    const agent1: AgentInfo = { id: '1', handle: 'alice' };
    const agent2: AgentInfo = { id: '2', handle: 'bob', team: 'A' };
    expect(agent1.team).toBeUndefined();
    expect(agent2.team).toBe('A');
  });
});
