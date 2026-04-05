import { describe, it, expect } from 'vitest';
import { LobbyPipeline } from '../server/lobby-pipeline.js';
import type { LobbyPhase, PhaseContext, PhaseResult, AgentInfo } from '../types.js';

function makePlayers(count: number): AgentInfo[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `p${i + 1}`,
    handle: `player${i + 1}`,
  }));
}

function makePhase(overrides: Partial<LobbyPhase> & { id: string }): LobbyPhase {
  return {
    name: overrides.id,
    async run(ctx: PhaseContext): Promise<PhaseResult> {
      return { groups: [ctx.players], metadata: {} };
    },
    ...overrides,
  };
}

describe('LobbyPipeline', () => {
  it('runs phases in order', async () => {
    const order: string[] = [];

    const pipeline = new LobbyPipeline([
      makePhase({
        id: 'first',
        async run(ctx) {
          order.push('first');
          return { groups: [ctx.players], metadata: { phase: 'first' } };
        },
      }),
      makePhase({
        id: 'second',
        async run(ctx) {
          order.push('second');
          return { groups: [ctx.players], metadata: { phase: 'second' } };
        },
      }),
    ]);

    await pipeline.start(makePlayers(4), {});
    expect(order).toEqual(['first', 'second']);
    expect(pipeline.isComplete()).toBe(true);
  });

  it('passes phase results to next phase', async () => {
    const pipeline = new LobbyPipeline([
      makePhase({
        id: 'split',
        async run(ctx) {
          const half = Math.ceil(ctx.players.length / 2);
          return {
            groups: [ctx.players.slice(0, half), ctx.players.slice(half)],
            metadata: { split: true },
          };
        },
      }),
      makePhase({
        id: 'verify',
        async run(ctx) {
          // Should receive all players flattened from previous groups
          return {
            groups: [ctx.players],
            metadata: { playerCount: ctx.players.length },
          };
        },
      }),
    ]);

    const players = makePlayers(4);
    await pipeline.start(players, {});

    const result = pipeline.getResult();
    expect(result.metadata.split).toBe(true);
    expect(result.metadata.playerCount).toBe(4);
  });

  it('handles player removal', async () => {
    const pipeline = new LobbyPipeline([
      makePhase({
        id: 'kick',
        async run(ctx) {
          const kept = ctx.players.slice(0, 3);
          const removed = ctx.players.slice(3);
          return { groups: [kept], metadata: {}, removed };
        },
      }),
      makePhase({
        id: 'count',
        async run(ctx) {
          return {
            groups: [ctx.players],
            metadata: { finalCount: ctx.players.length },
          };
        },
      }),
    ]);

    await pipeline.start(makePlayers(5), {});
    const result = pipeline.getResult();
    expect(result.metadata.finalCount).toBe(3);
  });

  it('merges metadata from all phases', async () => {
    const pipeline = new LobbyPipeline([
      makePhase({
        id: 'a',
        async run(ctx) {
          return { groups: [ctx.players], metadata: { teamSize: 2 } };
        },
      }),
      makePhase({
        id: 'b',
        async run(ctx) {
          return {
            groups: [ctx.players],
            metadata: { classes: { p1: 'rogue', p2: 'knight' } },
          };
        },
      }),
    ]);

    await pipeline.start(makePlayers(2), {});
    const result = pipeline.getResult();
    expect(result.metadata.teamSize).toBe(2);
    expect(result.metadata.classes).toBeDefined();
  });

  it('reports current phase correctly', async () => {
    let capturedPhase: any;

    const pipeline = new LobbyPipeline([
      makePhase({
        id: 'phase-a',
        name: 'Phase A',
        async run(ctx) {
          capturedPhase = { ...pipeline.getCurrentPhase() };
          return { groups: [ctx.players], metadata: {} };
        },
      }),
    ]);

    // Before start, phase info is available
    const before = pipeline.getCurrentPhase();
    expect(before.id).toBe('phase-a');
    expect(before.total).toBe(1);

    await pipeline.start(makePlayers(2), {});
    expect(capturedPhase.id).toBe('phase-a');
    expect(capturedPhase.index).toBe(0);
  });

  it('returns empty result when not started', () => {
    const pipeline = new LobbyPipeline([]);
    expect(pipeline.isComplete()).toBe(false);
    const result = pipeline.getResult();
    expect(result.groups).toEqual([]);
    expect(result.metadata).toEqual({});
  });

  it('handles empty phase list', async () => {
    const pipeline = new LobbyPipeline([]);
    await pipeline.start(makePlayers(4), {});
    expect(pipeline.isComplete()).toBe(true);
  });
});
