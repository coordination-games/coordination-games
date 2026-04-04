/**
 * Integration test: Full game lifecycle through the framework + relay.
 *
 * Verifies:
 * - CtL game runs through GameFramework
 * - Typed relay routes messages by scope
 * - Chat plugin (Tier 2) formats and extracts relay messages client-side
 * - Plugin pipeline runs client-side over relay data
 * - MCP tool visibility changes by phase
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  GameFramework,
  PluginLoader,
  LobbyPipeline,
  getAvailableTools,
  generateGuide,
} from '@lobster/platform';
import type { ToolPlugin, AgentInfo } from '@lobster/platform';
import { CaptureTheLobsterPlugin, TeamFormationPhase, ClassSelectionPhase } from '@lobster/games-ctl';
import { BasicChatPlugin, formatChatMessage, extractMessages } from '@lobster/plugin-chat';
import { createEloPlugin } from '@lobster/plugin-elo';
import { GameRelay } from '../typed-relay.js';

describe('Full game lifecycle', () => {
  let eloPlugin: ReturnType<typeof createEloPlugin>;

  afterEach(() => {
    if (eloPlugin) eloPlugin.tracker.close();
  });

  it('runs a complete CtL game through the framework', async () => {
    // 1. Create framework, register CtL plugin
    const framework = new GameFramework({ turnTimeoutMs: 5000 });
    framework.registerGame(CaptureTheLobsterPlugin);
    expect(framework.listGameTypes()).toContain('capture-the-lobster');

    // 2. Set up players
    const players: AgentInfo[] = [
      { id: 'p1', handle: 'alice', team: 'A' },
      { id: 'p2', handle: 'bob', team: 'A' },
      { id: 'p3', handle: 'carol', team: 'B' },
      { id: 'p4', handle: 'dave', team: 'B' },
    ];

    // 3. Run lobby pipeline (team formation + class selection)
    const pipeline = new LobbyPipeline([TeamFormationPhase, ClassSelectionPhase]);
    await pipeline.start(players, { teamSize: 2 });
    expect(pipeline.isComplete()).toBe(true);

    const lobbyResult = pipeline.getResult();
    expect(lobbyResult.metadata.classPicks).toBeDefined();

    // 4. Create game room
    const classPicks = lobbyResult.metadata.classPicks;
    const config = {
      mapSeed: 'integration-test',
      teamSize: 2,
      turnLimit: 5,
      players: [
        { id: 'p1', team: 'A' as const, unitClass: classPicks['p1'] ?? 'rogue' },
        { id: 'p2', team: 'A' as const, unitClass: classPicks['p2'] ?? 'knight' },
        { id: 'p3', team: 'B' as const, unitClass: classPicks['p3'] ?? 'mage' },
        { id: 'p4', team: 'B' as const, unitClass: classPicks['p4'] ?? 'rogue' },
      ],
    };
    const room = framework.createRoom('capture-the-lobster', config, ['p1', 'p2', 'p3', 'p4']);
    expect(room.phase).toBe('in_progress');

    // 5. Create relay for this game
    const relay = new GameRelay([
      { id: 'p1', team: 'A' }, { id: 'p2', team: 'A' },
      { id: 'p3', team: 'B' }, { id: 'p4', team: 'B' },
    ]);

    // 6. Chat via relay (Tier 2 flow)
    const chatData = formatChatMessage('rush the flag!', 'in_progress');
    relay.send('p1', room.turn, chatData);

    // p2 (same team) gets the message
    const p2Messages = relay.receive('p2');
    expect(p2Messages).toHaveLength(1);
    expect(p2Messages[0].type).toBe('messaging');

    // p3 (enemy team) doesn't get team-scoped message
    const p3Messages = relay.receive('p3');
    expect(p3Messages).toHaveLength(0);

    // 7. Client-side pipeline processes relay messages
    const extracted = extractMessages(p2Messages);
    expect(extracted).toHaveLength(1);
    expect(extracted[0].body).toBe('rush the flag!');
    expect(extracted[0].scope).toBe('team');

    // 8. Pipeline with chat plugin
    const loader = new PluginLoader();
    loader.register(BasicChatPlugin);
    const pluginPipeline = loader.buildPipeline(['basic-chat']);
    const pipelineResult = pluginPipeline.execute(
      new Map([['relay-messages', p2Messages]]),
    );
    expect(pipelineResult.get('messaging')).toHaveLength(1);

    // 9. Submit moves and resolve turns until game ends
    for (let i = 0; i < 10 && room.phase === 'in_progress'; i++) {
      for (const id of ['p1', 'p2', 'p3', 'p4']) {
        framework.submitMove(room.roomId, id, { path: [] });
      }
      framework.resolveTurn(room.roomId);
    }
    expect(room.phase).toBe('finished');

    // 10. Verify game result
    const result = framework.finishGame(room.roomId);
    expect(result).not.toBeNull();
    expect(result!.result.gameType).toBe('capture-the-lobster');
    expect(result!.result.movesRoot).toBeTruthy();

    // 11. Spectators see all relay messages
    const spectatorMsgs = relay.getSpectatorMessages(room.turn);
    expect(spectatorMsgs).toHaveLength(1); // the chat message
  });

  it('relay routes by scope — team messages stay private', () => {
    const relay = new GameRelay([
      { id: 'a1', team: 'A' }, { id: 'a2', team: 'A' },
      { id: 'b1', team: 'B' },
    ]);

    // Team A chat
    const teamChat = formatChatMessage('secret plan', 'in_progress');
    relay.send('a1', 1, teamChat);

    // All chat
    const allChat = formatChatMessage('gg', 'lobby');
    relay.send('a1', 1, allChat);

    // Team A member sees both
    const a2Msgs = relay.receive('a2');
    expect(a2Msgs).toHaveLength(2);

    // Team B member sees only the 'all' scoped message
    const b1Msgs = relay.receive('b1');
    expect(b1Msgs).toHaveLength(1);
    expect((b1Msgs[0].data as any).body).toBe('gg');
  });

  it('plugin pipeline processes data in correct order', () => {
    const loader = new PluginLoader();
    loader.register(BasicChatPlugin);

    // Mock enricher that adds tags to messages
    const enricher: ToolPlugin = {
      id: 'enricher',
      version: '0.1.0',
      modes: [{ name: 'enrich', consumes: ['messaging'], provides: ['enriched'] }],
      purity: 'pure',
      handleData(mode, inputs) {
        const msgs = inputs.get('messaging') ?? [];
        return new Map([['enriched', msgs.map((m: any) => ({ ...m, enriched: true }))]]);
      },
    };
    loader.register(enricher);

    const pipeline = loader.buildPipeline(['basic-chat', 'enricher']);
    expect(pipeline.steps[0].plugin.id).toBe('basic-chat');
    expect(pipeline.steps[1].plugin.id).toBe('enricher');

    const relayMsgs = [{
      type: 'messaging', data: { body: 'test' }, scope: 'team' as const,
      pluginId: 'basic-chat', sender: '1', turn: 1, timestamp: Date.now(), index: 0,
    }];

    const result = pipeline.execute(new Map([['relay-messages', relayMsgs]]));
    expect(result.get('messaging')).toHaveLength(1);
    expect(result.get('enriched')).toHaveLength(1);
    expect(result.get('enriched')[0].enriched).toBe(true);
  });

  it('MCP tools change based on game phase', () => {
    // Lobby phase — no game tools
    const lobbyTools = getAvailableTools('lobby', []);
    const lobbyNames = lobbyTools.map((t) => t.name);
    expect(lobbyNames).toContain('get_guide');
    expect(lobbyNames).not.toContain('submit_move');

    // Team formation — lobby-specific tools
    const teamTools = getAvailableTools('team-formation', []);
    expect(teamTools.map(t => t.name)).toContain('propose_team');

    // Game phase — gameplay tools
    const gameTools = getAvailableTools('in_progress', []);
    const gameNames = gameTools.map(t => t.name);
    expect(gameNames).toContain('submit_move');
    expect(gameNames).toContain('get_state');
    expect(gameNames).not.toContain('propose_team');
  });

  it('generates dynamic guide with game + plugin info', () => {
    const guide = generateGuide({
      gameType: 'Capture the Lobster',
      gameRules: 'Hex grid CTF. First capture wins.',
      activePlugins: [BasicChatPlugin],
      phase: 'in_progress',
      playerState: { elo: 1250, team: 'A' },
    });

    expect(guide).toContain('Capture the Lobster');
    expect(guide).toContain('basic-chat');
    expect(guide).toContain('1250');
  });
});
