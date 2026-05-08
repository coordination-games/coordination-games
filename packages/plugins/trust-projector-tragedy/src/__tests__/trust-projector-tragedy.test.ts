import type { AttestationV1, RelayEnvelope } from '@coordination-games/engine';
import { describe, expect, it } from 'vitest';
import {
  ATTESTATION_RELAY_TYPE,
  isAttestation,
  projectTragedyTrust,
  TrustProjectorTragedyPlugin,
} from '../index.js';

const attestation: AttestationV1 = {
  schemaVersion: 'attestation/v1',
  id: 'attestation-1',
  issuer: 'tragedy-of-the-commons:game-1',
  issuerKind: 'system',
  subject: 'player-1',
  claim: {
    type: 'tragedy.round_choice.v1',
    data: {
      gameType: 'tragedy-of-the-commons',
      round: 2,
      actor: 'player-1',
      actionType: 'build_settlement',
      action: { type: 'build_settlement', regionId: 'forest' },
    },
  },
  note: 'Built a settlement from visible resources.',
  round: 2,
  issuedAt: '2026-05-01T00:00:00.000Z',
};

const relay: RelayEnvelope = {
  type: ATTESTATION_RELAY_TYPE,
  data: attestation,
  scope: { kind: 'all' },
  pluginId: 'trust-projector-tragedy',
  sender: 'system',
  turn: 2,
  timestamp: Date.parse('2026-05-01T00:00:00.000Z'),
  index: 0,
};

const v2Attestation: AttestationV1 = {
  schemaVersion: 'attestation/v1',
  id: 'attestation-v2-1',
  issuer: 'tragedy-of-the-commons:game-2',
  issuerKind: 'system',
  subject: 'player-1',
  claim: {
    type: 'tragedy.round_choice.v1',
    data: {
      gameType: 'tragedy-of-the-commons',
      round: 3,
      actor: 'player-1',
      actionType: 'extract_tile',
      action: { type: 'extract_tile', tileId: '0,0', resource: 'water', level: 'low' },
    },
  },
  note: 'Extracted lightly from an adjacent tile.',
  round: 3,
  issuedAt: '2026-05-01T00:00:00.000Z',
};

const v2Relay: RelayEnvelope = {
  type: ATTESTATION_RELAY_TYPE,
  data: v2Attestation,
  scope: { kind: 'all' },
  pluginId: 'trust-projector-tragedy',
  sender: 'system',
  turn: 3,
  timestamp: Date.parse('2026-05-01T00:00:00.000Z'),
  index: 1,
};

const tragedyState = {
  gameType: 'tragedy-of-the-commons',
  gameId: 'game-1',
  round: 2,
  phase: 'playing',
  players: [
    {
      id: 'player-1',
      resources: { wood: 4, ore: 2, fish: 1 },
      influence: 3,
      vp: 1,
      regionsControlled: ['forest', 'river'],
    },
  ],
};

const tragedyV2State = {
  gameType: 'tragedy-of-the-commons',
  gameId: 'game-2',
  round: 3,
  phase: 'playing',
  commonsHealthPercent: 75,
  players: [
    {
      id: 'player-1',
      resources: { grain: 0, timber: 2, ore: 1, fish: 1, water: 2, energy: 3 },
      influence: 4,
      vp: 2,
      ownedStructureIds: ['structure-camp-1', 'structure-solar-1'],
      ownedRoadIds: ['road-1'],
      structures: [
        {
          id: 'structure-camp-1',
          ownerId: 'player-1',
          intersectionId: 'intersection-a',
          type: 'camp',
          extractionsThisRound: 1,
        },
        {
          id: 'structure-solar-1',
          ownerId: 'player-1',
          intersectionId: 'intersection-b',
          type: 'solar-farm',
          extractionsThisRound: 0,
        },
      ],
      roads: [
        {
          id: 'road-1',
          ownerId: 'player-1',
          fromIntersectionId: 'intersection-a',
          toIntersectionId: 'intersection-b',
        },
      ],
      tiles: [
        { id: '0,0', health: 15, maxHealth: 20 },
        { id: '1,0', health: 15, maxHealth: 20 },
      ],
    },
  ],
};

describe('trust-projector-tragedy', () => {
  it('validates attestation payloads', () => {
    expect(isAttestation(attestation)).toBe(true);
    expect(isAttestation({ ...attestation, schemaVersion: 'trust-card/v1' })).toBe(false);
  });

  it('projects visible tragedy state and relay attestations into trust cards', () => {
    const artifacts = projectTragedyTrust({
      state: tragedyState,
      relayMessages: [relay],
      meta: {
        gameId: 'game-1',
        gameType: 'tragedy-of-the-commons',
        handleMap: { 'player-1': 'Alicia Commons' },
        progressCounter: 7,
      },
    });

    expect(artifacts.cards).toHaveLength(1);
    expect(artifacts.envelopes).toHaveLength(1);
    expect(artifacts.cards[0]).toMatchObject({
      schemaVersion: 'trust-card/v1',
      agentId: 'player-1',
      subjectId: 'player-1',
      headline: 'Viewer-visible trust context',
    });
    expect(artifacts.cards[0]?.summary).toContain('Alicia Commons has 1 VP');
    expect(artifacts.cards[0]?.signals.map((signal) => signal.label)).toEqual([
      'Visible table position',
      'Resource pressure context',
      'Latest visible action',
    ]);
    expect(artifacts.cards[0]?.signals[2]).toMatchObject({ stance: 'positive' });
    expect(artifacts.cards[0]?.evidenceRefs[0]).toMatchObject({
      id: 'attestation-1',
      visibility: 'public',
    });
    expect(artifacts.envelopes[0]).toMatchObject({
      schemaVersion: 'trust-evidence/v1',
      subject: 'player-1',
      category: 'outcome',
      privacy: {
        publishable: true,
        redaction: 'aggregated',
        containsPrivateChat: false,
        containsHiddenState: false,
      },
    });
  });

  it('projects V2 structures, roads, solar, extraction pressure, and tile health', () => {
    const artifacts = projectTragedyTrust({
      state: tragedyV2State,
      relayMessages: [v2Relay],
      meta: {
        gameId: 'game-2',
        gameType: 'tragedy-of-the-commons',
        handleMap: { 'player-1': 'Alicia Commons' },
        progressCounter: 8,
      },
    });

    expect(artifacts.cards).toHaveLength(1);
    expect(artifacts.envelopes).toHaveLength(1);
    expect(artifacts.cards[0]?.summary).toContain('2 structures');
    expect(artifacts.cards[0]?.summary).toContain('1 roads');
    expect(artifacts.cards[0]?.summary).toContain('1 solar investments');
    expect(artifacts.cards[0]?.summary).toContain('commons health is 75%');
    expect(artifacts.cards[0]?.summary).not.toContain('regions');
    expect(artifacts.cards[0]?.signals.map((signal) => signal.label)).toEqual([
      'Visible table position',
      'Resource pressure context',
      'Latest visible action',
      'Structural network',
      'Solar investment',
      'Extraction pressure',
      'Commons health',
    ]);
    expect(artifacts.cards[0]?.signals[2]).toMatchObject({ stance: 'informational' });
    expect(artifacts.envelopes[0]?.payload).toMatchObject({
      player: {
        structureCount: 2,
        roadCount: 1,
        solarCount: 1,
        extractionPressure: 1,
        commonsHealthPercent: 75,
      },
    });
  });

  it('exposes projected cards through the ToolPlugin envelope key', () => {
    const outputs = TrustProjectorTragedyPlugin.handleData?.(
      'trust-cards',
      new Map<string, unknown>([
        ['game-state', tragedyState],
        ['relay-messages', [relay]],
        ['game-meta', { gameId: 'game-1', gameType: 'tragedy-of-the-commons' }],
      ]),
    );

    expect(TrustProjectorTragedyPlugin.agentEnvelopeKeys?.['trust-cards']).toBe('trustCards');
    const cards = outputs?.get('trust-cards');
    expect(cards).toMatchObject([
      {
        schemaVersion: 'trust-card/v1',
        agentId: 'player-1',
        evidenceRefs: [{ id: 'attestation-1' }],
      },
    ]);
  });

  it('does not project non-tragedy states', () => {
    expect(
      projectTragedyTrust({
        state: { gameType: 'capture-the-lobster', players: [] },
        relayMessages: [relay],
      }),
    ).toEqual({ cards: [], envelopes: [] });
  });
});
