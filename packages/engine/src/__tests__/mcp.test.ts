import { describe, it, expect } from 'vitest';
import { getAvailableTools, generateGuide, PHASE_TOOLS } from '../mcp.js';
import type { ToolPlugin } from '../types.js';

function makePlugin(overrides: Partial<ToolPlugin> & { id: string }): ToolPlugin {
  return {
    version: '0.1.0',
    modes: [],
    purity: 'pure',
    handleData: () => new Map(),
    ...overrides,
  };
}

describe('Platform MCP', () => {
  describe('getAvailableTools', () => {
    it('always includes get_guide', () => {
      const tools = getAvailableTools('lobby', []);
      expect(tools.find((t) => t.name === 'get_guide')).toBeDefined();
    });

    it('returns team formation tools during team-formation phase', () => {
      const tools = getAvailableTools('team-formation', []);
      const names = tools.map((t) => t.name);
      expect(names).toContain('propose_team');
      expect(names).toContain('accept_team');
      expect(names).toContain('leave_team');
      expect(names).toContain('wait_for_update');
    });

    it('returns class selection tools during class-selection phase', () => {
      const tools = getAvailableTools('class-selection', []);
      const names = tools.map((t) => t.name);
      expect(names).toContain('choose_class');
      expect(names).not.toContain('propose_team');
    });

    it('returns gameplay tools during in_progress phase', () => {
      const tools = getAvailableTools('in_progress', []);
      const names = tools.map((t) => t.name);
      expect(names).toContain('get_state');
      expect(names).toContain('submit_move');
      expect(names).toContain('wait_for_update');
      expect(names).not.toContain('propose_team');
      expect(names).not.toContain('choose_class');
    });

    it('includes plugin tools when active', () => {
      const chatPlugin = makePlugin({
        id: 'basic-chat',
        tools: [{ name: 'chat', description: 'Send a message', inputSchema: {} }],
      });
      const tools = getAvailableTools('in_progress', [chatPlugin]);
      const names = tools.map((t) => t.name);
      expect(names).toContain('chat');
      expect(names).toContain('get_state');
    });

    it('excludes plugin tools when plugin is not active', () => {
      const tools = getAvailableTools('in_progress', []);
      const names = tools.map((t) => t.name);
      expect(names).not.toContain('chat');
    });

    it('handles unknown phase gracefully', () => {
      const tools = getAvailableTools('unknown-phase', []);
      // Should still have get_guide
      expect(tools.find((t) => t.name === 'get_guide')).toBeDefined();
      // No phase-specific tools
      expect(tools).toHaveLength(1);
    });

    it('returns no wait_for_update during lobby', () => {
      const tools = getAvailableTools('lobby', []);
      expect(tools.find((t) => t.name === 'wait_for_update')).toBeUndefined();
    });

    it('returns no wait_for_update during finished', () => {
      const tools = getAvailableTools('finished', []);
      expect(tools.find((t) => t.name === 'wait_for_update')).toBeUndefined();
    });
  });

  describe('generateGuide', () => {
    it('includes game type and phase', () => {
      const guide = generateGuide({
        gameType: 'Capture the Lobster',
        activePlugins: [],
        phase: 'in_progress',
      });
      expect(guide).toContain('Capture the Lobster');
      expect(guide).toContain('in_progress');
    });

    it('includes game rules when provided', () => {
      const guide = generateGuide({
        gameType: 'Test',
        gameRules: 'First to capture wins',
        activePlugins: [],
        phase: 'lobby',
      });
      expect(guide).toContain('First to capture wins');
    });

    it('lists active plugins with tools', () => {
      const chatPlugin = makePlugin({
        id: 'basic-chat',
        tools: [{ name: 'chat', description: 'Send a message', inputSchema: {} }],
      });
      const guide = generateGuide({
        gameType: 'Test',
        activePlugins: [chatPlugin],
        phase: 'in_progress',
      });
      expect(guide).toContain('basic-chat');
      expect(guide).toContain('`chat`');
    });

    it('includes player state when provided', () => {
      const guide = generateGuide({
        gameType: 'Test',
        activePlugins: [],
        phase: 'in_progress',
        playerState: { elo: 1250, team: 'A' },
      });
      expect(guide).toContain('1250');
      expect(guide).toContain('elo');
    });

    it('lists available tools for the phase', () => {
      const guide = generateGuide({
        gameType: 'Test',
        activePlugins: [],
        phase: 'in_progress',
      });
      expect(guide).toContain('`get_state`');
      expect(guide).toContain('`submit_move`');
    });
  });
});
