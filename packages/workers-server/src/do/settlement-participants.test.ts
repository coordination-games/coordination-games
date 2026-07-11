import { describe, expect, it } from 'vitest';
import {
  assembleSettlementParticipants,
  type TreasuryPlayerRow,
} from './settlement-participants.js';

const PLAYERS = ['player-a', 'player-b'];
const DELTAS = [
  { agentId: 'player-a', delta: 75n },
  { agentId: 'player-b', delta: -75n },
];

const TREASURY: TreasuryPlayerRow = {
  id: 'treasury-player-id',
  chainAgentId: 303,
};

describe('assembleSettlementParticipants', () => {
  it('Given no treasury environment handle, when assembling settlement participants, then preserves the existing playing arrays exactly', async () => {
    const lookup = async (_handle: string): Promise<TreasuryPlayerRow | null> => TREASURY;

    const result = await assembleSettlementParticipants({
      playerIds: PLAYERS,
      deltas: DELTAS,
      treasuryHandle: undefined,
      findByHandle: lookup,
    });

    expect(result.kind).toBe('ready');
    if (result.kind === 'ready') {
      expect(result.playerIds).toBe(PLAYERS);
      expect(result.deltas).toBe(DELTAS);
      expect(result.playerIds).toEqual(['player-a', 'player-b']);
      expect(result.deltas).toEqual([
        { agentId: 'player-a', delta: 75n },
        { agentId: 'player-b', delta: -75n },
      ]);
    }
  });

  it('Given a configured registered treasury, when assembling settlement participants, then appends its UUID and zero delta in aligned order', async () => {
    const result = await assembleSettlementParticipants({
      playerIds: PLAYERS,
      deltas: DELTAS,
      treasuryHandle: 'tournament-treasury',
      findByHandle: async (handle) => (handle === 'tournament-treasury' ? TREASURY : null),
    });

    expect(result).toEqual({
      kind: 'ready',
      playerIds: ['player-a', 'player-b', 'treasury-player-id'],
      deltas: [
        { agentId: 'player-a', delta: 75n },
        { agentId: 'player-b', delta: -75n },
        { agentId: 'treasury-player-id', delta: 0n },
      ],
    });
  });

  it('Given a configured treasury handle with no D1 player row, when assembling settlement participants, then fails closed before submit', async () => {
    const result = await assembleSettlementParticipants({
      playerIds: PLAYERS,
      deltas: DELTAS,
      treasuryHandle: 'missing-treasury',
      findByHandle: async () => null,
    });

    expect(result).toEqual({
      kind: 'invalid',
      reason: 'configured treasury handle "missing-treasury" has no players row',
    });
  });

  it('Given a configured treasury row without a chain agent identity, when assembling settlement participants, then fails closed before submit', async () => {
    const result = await assembleSettlementParticipants({
      playerIds: PLAYERS,
      deltas: DELTAS,
      treasuryHandle: 'unregistered-treasury',
      findByHandle: async () => ({ id: 'treasury-player-id', chainAgentId: null }),
    });

    expect(result).toEqual({
      kind: 'invalid',
      reason: 'configured treasury handle "unregistered-treasury" has no chain_agent_id',
    });
  });
});
