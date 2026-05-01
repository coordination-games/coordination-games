import { describe, expect, it } from 'vitest';

import { buildVisibleTrustArtifacts, buildVisibleTrustCards } from './trust-cards.js';

const tragedyMeta = {
  gameId: 'game-1',
  gameType: 'tragedy-of-the-commons',
  handleMap: { alice: 'Alicia Commons' },
  finished: false,
};

describe('visible tragedy trust cards', () => {
  it('uses the in-repo trust projector while preserving the engine wire shape', () => {
    const cards = buildVisibleTrustCards(
      {
        round: 2,
        phase: 'playing',
        players: [
          {
            id: 'alice',
            influence: 2,
            vp: 5,
            resources: { timber: 3, ore: 4 },
            regionsControlled: ['forest'],
            lastAction: 'build_settlement',
          },
        ],
      },
      tragedyMeta,
      9,
    );

    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      schemaVersion: 'trust-card/v1',
      agentId: 'alice',
      headline: 'Viewer-visible trust context',
    });
    expect(cards[0]?.summary).toContain('Alicia Commons');
    expect(cards[0]?.signals.map((signal) => signal.label)).toEqual([
      'Visible table position',
      'Resource pressure context',
      'Latest visible action',
    ]);
    expect(cards[0]?.evidenceRefs[0]).toMatchObject({
      kind: 'tragedy.visible-state',
      visibility: 'viewer-visible',
      round: 2,
    });
    expect(cards[0]?.caveats.join(' ')).toContain('Does not include private DMs');
  });

  it('does not emit cards for other games or malformed visible states', () => {
    expect(
      buildVisibleTrustCards(
        { players: [{ id: 'alice' }] },
        { ...tragedyMeta, gameType: 'other' },
        1,
      ),
    ).toEqual([]);
    expect(buildVisibleTrustCards(null, tragedyMeta, 1)).toEqual([]);
    expect(buildVisibleTrustCards({ players: [] }, tragedyMeta, 1)).toEqual([]);
  });

  it('returns projection artifacts without mutating the original visible state object', () => {
    const visible = { round: 1, players: [{ id: 'alice', influence: 1, vp: 0 }] };
    const artifacts = buildVisibleTrustArtifacts(visible, tragedyMeta, 1);

    expect(visible).not.toHaveProperty('trustCards');
    expect(artifacts.cards).toMatchObject([{ agentId: 'alice' }]);
  });
});
