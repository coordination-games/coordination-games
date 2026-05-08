import { describe, expect, it } from 'vitest';
import { extractReasoningEntries, formatReasoningMessage, ReasoningPlugin } from '../index.js';

describe('ReasoningPlugin', () => {
  it('formats outgoing reasoning relay data', () => {
    const relay = formatReasoningMessage('We should coordinate left flank.', 'team', 'planning');
    expect(relay.type).toBe('reasoning');
    expect(relay.pluginId).toBe('reasoning');
    expect(relay.scope).toBe('team');
    expect(relay.data).toEqual({
      body: 'We should coordinate left flank.',
      stage: 'planning',
    });
  });

  it('extracts reasoning entries from raw relay messages', () => {
    const entries = extractReasoningEntries([
      {
        type: 'reasoning',
        data: {
          body: 'Commit to cooperation this round.',
          stage: 'negotiation',
        },
        scope: 'all',
        pluginId: 'reasoning',
        sender: 'agent-1',
        turn: 3,
        timestamp: 123,
        index: 0,
      },
    ]);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      from: 'agent-1',
      body: 'Commit to cooperation this round.',
      turn: 3,
      scope: 'all',
      stage: 'negotiation',
    });
  });

  it('publishes reasoning relay payloads through the plugin tool', () => {
    const result = ReasoningPlugin.handleCall?.(
      'share_reasoning',
      { message: 'Trade ore for tempo.', scope: 'agent-2', stage: 'action' },
      { id: 'agent-1', handle: 'alice' },
    ) as { relay: ReturnType<typeof formatReasoningMessage> };

    expect(result.relay).toEqual({
      type: 'reasoning',
      data: { body: 'Trade ore for tempo.', stage: 'action' },
      scope: 'agent-2',
      pluginId: 'reasoning',
    });
  });
});
