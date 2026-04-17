import { describe, expect, it } from 'vitest';
import { RationalePlugin, extractRationales, formatRationaleMessage } from '../index.js';

describe('RationalePlugin', () => {
  it('formats outgoing rationale relay data', () => {
    const relay = formatRationaleMessage('We should coordinate left flank.', 'team', 'planning');
    expect(relay.type).toBe('rationale');
    expect(relay.pluginId).toBe('rationale');
    expect(relay.scope).toBe('team');
    expect(relay.data).toEqual({ body: 'We should coordinate left flank.', stage: 'planning' });
  });

  it('extracts rationale entries from raw relay messages', () => {
    const entries = extractRationales([
      {
        type: 'rationale',
        data: { body: 'Commit to cooperation this round.', stage: 'negotiation' },
        scope: 'all',
        pluginId: 'rationale',
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

  it('publishes rationale relay payloads through the plugin tool', () => {
    const result = RationalePlugin.handleCall?.(
      'share_rationale',
      { message: 'Trade ore for tempo.', scope: 'agent-2', stage: 'action' },
      { id: 'agent-1', handle: 'alice' },
    ) as any;

    expect(result.relay).toEqual({
      type: 'rationale',
      data: { body: 'Trade ore for tempo.', stage: 'action' },
      scope: 'agent-2',
      pluginId: 'rationale',
    });
  });
});
