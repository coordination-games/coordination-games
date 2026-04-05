import { describe, it, expect } from 'vitest';
import { PluginLoader, PluginPipeline } from '../plugin-loader.js';
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

describe('PluginLoader', () => {
  describe('register and list', () => {
    it('registers and retrieves plugins', () => {
      const loader = new PluginLoader();
      const plugin = makePlugin({ id: 'chat' });
      loader.register(plugin);
      expect(loader.getPlugin('chat')).toBe(plugin);
      expect(loader.listPlugins()).toEqual(['chat']);
    });

    it('returns undefined for unknown plugin', () => {
      const loader = new PluginLoader();
      expect(loader.getPlugin('nope')).toBeUndefined();
    });
  });

  describe('buildPipeline', () => {
    it('orders producer before consumer', () => {
      const loader = new PluginLoader();
      const producer = makePlugin({
        id: 'chat',
        modes: [{ name: 'produce', consumes: [], provides: ['messaging'] }],
        handleData: (mode, inputs) => new Map([['messaging', ['hello']]]),
      });
      const consumer = makePlugin({
        id: 'logger',
        modes: [{ name: 'log', consumes: ['messaging'], provides: ['log-output'] }],
        handleData: (mode, inputs) => {
          const msgs = inputs.get('messaging') ?? [];
          return new Map([['log-output', msgs.length]]);
        },
      });

      loader.register(producer);
      loader.register(consumer);

      const pipeline = loader.buildPipeline(['chat', 'logger']);
      expect(pipeline.steps).toHaveLength(2);
      expect(pipeline.steps[0].plugin.id).toBe('chat');
      expect(pipeline.steps[1].plugin.id).toBe('logger');
    });

    it('handles linear chain (producer → mapper → enricher → filter)', () => {
      const loader = new PluginLoader();

      loader.register(makePlugin({
        id: 'source',
        modes: [{ name: 'produce', consumes: [], provides: ['raw'] }],
      }));
      loader.register(makePlugin({
        id: 'mapper',
        modes: [{ name: 'map', consumes: ['raw'], provides: ['mapped'] }],
      }));
      loader.register(makePlugin({
        id: 'enricher',
        modes: [{ name: 'enrich', consumes: ['mapped'], provides: ['enriched'] }],
      }));
      loader.register(makePlugin({
        id: 'filter',
        modes: [{ name: 'filter', consumes: ['enriched'], provides: ['filtered'] }],
      }));

      // Register in reverse order to test that sorting works
      const pipeline = loader.buildPipeline(['filter', 'enricher', 'mapper', 'source']);
      const ids = pipeline.steps.map((s) => s.plugin.id);
      expect(ids.indexOf('source')).toBeLessThan(ids.indexOf('mapper'));
      expect(ids.indexOf('mapper')).toBeLessThan(ids.indexOf('enricher'));
      expect(ids.indexOf('enricher')).toBeLessThan(ids.indexOf('filter'));
    });

    it('handles parallel providers (independent plugins merge)', () => {
      const loader = new PluginLoader();

      loader.register(makePlugin({
        id: 'source',
        modes: [{ name: 'produce', consumes: [], provides: ['agents'] }],
      }));
      loader.register(makePlugin({
        id: 'trust',
        modes: [{ name: 'enrich', consumes: ['agents'], provides: ['agent-tags'] }],
      }));
      loader.register(makePlugin({
        id: 'reputation',
        modes: [{ name: 'enrich', consumes: ['agents'], provides: ['agent-tags'] }],
      }));

      const pipeline = loader.buildPipeline(['source', 'trust', 'reputation']);
      expect(pipeline.steps).toHaveLength(3);
      // Source must come first, trust and reputation can be in any order after
      expect(pipeline.steps[0].plugin.id).toBe('source');
    });

    it('detects and rejects cycles', () => {
      const loader = new PluginLoader();

      loader.register(makePlugin({
        id: 'a',
        modes: [{ name: 'a', consumes: ['b-data'], provides: ['a-data'] }],
      }));
      loader.register(makePlugin({
        id: 'b',
        modes: [{ name: 'b', consumes: ['a-data'], provides: ['b-data'] }],
      }));

      expect(() => loader.buildPipeline(['a', 'b'])).toThrow(/cycle/i);
    });

    it('throws on unknown plugin', () => {
      const loader = new PluginLoader();
      expect(() => loader.buildPipeline(['nonexistent'])).toThrow(/Unknown plugin/);
    });

    it('returns empty pipeline for no plugins', () => {
      const loader = new PluginLoader();
      const pipeline = loader.buildPipeline([]);
      expect(pipeline.steps).toHaveLength(0);
    });
  });

  describe('pipeline execution', () => {
    it('passes data through pipeline correctly', () => {
      const loader = new PluginLoader();

      loader.register(makePlugin({
        id: 'chat',
        modes: [{ name: 'produce', consumes: [], provides: ['messaging'] }],
        handleData: () => new Map([['messaging', [{ text: 'hello' }, { text: 'world' }]]]),
      }));

      loader.register(makePlugin({
        id: 'counter',
        modes: [{ name: 'count', consumes: ['messaging'], provides: ['stats'] }],
        handleData: (mode, inputs) => {
          const msgs = inputs.get('messaging') ?? [];
          return new Map([['stats', { count: msgs.length }]]);
        },
      }));

      const pipeline = loader.buildPipeline(['chat', 'counter']);
      const result = pipeline.execute(new Map());

      expect(result.get('messaging')).toHaveLength(2);
      expect(result.get('stats')).toEqual({ count: 2 });
    });

    it('later steps can override data from earlier steps', () => {
      const loader = new PluginLoader();

      loader.register(makePlugin({
        id: 'raw',
        modes: [{ name: 'produce', consumes: [], provides: ['data'] }],
        handleData: () => new Map([['data', [1, 2, 3]]]),
      }));

      loader.register(makePlugin({
        id: 'filter',
        modes: [{ name: 'filter', consumes: ['data'], provides: ['data'] }],
        handleData: (mode, inputs) => {
          const data = inputs.get('data') ?? [];
          return new Map([['data', data.filter((x: number) => x > 1)]]);
        },
      }));

      const pipeline = loader.buildPipeline(['raw', 'filter']);
      const result = pipeline.execute(new Map());
      expect(result.get('data')).toEqual([2, 3]);
    });

    it('preserves initial data alongside pipeline outputs', () => {
      const loader = new PluginLoader();

      loader.register(makePlugin({
        id: 'plugin',
        modes: [{ name: 'produce', consumes: [], provides: ['new-data'] }],
        handleData: () => new Map([['new-data', 42]]),
      }));

      const pipeline = loader.buildPipeline(['plugin']);
      const result = pipeline.execute(new Map([['existing', 'kept']]));
      expect(result.get('existing')).toBe('kept');
      expect(result.get('new-data')).toBe(42);
    });
  });

  describe('getTools', () => {
    it('returns tools from active plugins only', () => {
      const loader = new PluginLoader();

      loader.register(makePlugin({
        id: 'chat',
        tools: [{ name: 'send_chat', description: 'Send a chat message', inputSchema: {} }],
      }));

      loader.register(makePlugin({
        id: 'elo',
        tools: [{ name: 'get_leaderboard', description: 'Get leaderboard', inputSchema: {} }],
      }));

      loader.register(makePlugin({
        id: 'silent',
        // no tools
      }));

      const tools = loader.getTools(['chat', 'silent']);
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('send_chat');
    });

    it('returns empty array when no plugins have tools', () => {
      const loader = new PluginLoader();
      loader.register(makePlugin({ id: 'no-tools' }));
      expect(loader.getTools(['no-tools'])).toEqual([]);
    });
  });
});
