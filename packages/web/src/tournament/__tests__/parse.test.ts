import { describe, expect, it } from 'vitest';
import { parseTournamentState, TournamentParseError } from '../parse';

function validPayload(): Record<string, unknown> {
  return {
    tournamentId: 'trn-1',
    gameType: 'tragedy-of-the-commons',
    standings: [
      { playerId: 'p1', cumulativeDelta: '1200', gamesPlayed: 2 },
      { playerId: 'p2', cumulativeDelta: '-300', gamesPlayed: 2 },
    ],
    activePlayerIds: ['p1'],
    eliminatedPlayerIds: ['p2'],
    currentGameId: null,
    currentGameIndex: 2,
    gameIds: ['g0', 'g1'],
    policy: { baseEntryCost: '1000', carryBps: '250', slashBps: '500' },
    treasuryCarry: '450',
    currentEconomics: {
      baseEntryCost: '1000',
      entryCost: '1000',
      playerCount: 2,
      basePot: '2000',
      incomingCarry: '0',
      releasedCarry: '0',
      carryRemainder: '0',
      carry: '50',
      slash: '100',
      treasuryDelta: '150',
    },
    lastSettlement: {
      gameId: 'g1',
      gameIndex: 1,
      txHash: '0xabc123def456789000',
      blockNumber: 42,
      entryCost: '1000',
      carry: '50',
      slash: '100',
      treasuryDelta: '150',
    },
    status: 'completed',
  };
}

describe('parseTournamentState', () => {
  it('parses a valid completed two-game payload', () => {
    // Given a well-formed public state / When parsed / Then all fields survive typed.
    const state = parseTournamentState(validPayload());
    expect(state.tournamentId).toBe('trn-1');
    expect(state.standings).toHaveLength(2);
    expect(state.standings[0]?.cumulativeDelta).toBe('1200');
    expect(state.policy.carryBps).toBe('250');
    expect(state.currentEconomics?.treasuryDelta).toBe('150');
    expect(state.lastSettlement?.txHash).toBe('0xabc123def456789000');
    expect(state.status).toBe('completed');
  });

  it('accepts null economics and null settlement (no-receipt state)', () => {
    const raw = { ...validPayload(), currentEconomics: null, lastSettlement: null };
    const state = parseTournamentState(raw);
    expect(state.currentEconomics).toBeNull();
    expect(state.lastSettlement).toBeNull();
  });

  it('treats a missing currentEconomics/lastSettlement key as null', () => {
    const raw = validPayload();
    delete raw.currentEconomics;
    delete raw.lastSettlement;
    const state = parseTournamentState(raw);
    expect(state.currentEconomics).toBeNull();
    expect(state.lastSettlement).toBeNull();
  });

  it('drops any non-allow-listed field (no secret/root/entropy/endpoint leak)', () => {
    // Given a payload contaminated with private-looking fields.
    const raw = {
      ...validPayload(),
      tournamentRootSeed: '0xdeadbeef',
      playerEntropy: '0xsecret',
      internalEndpoint: 'https://do.internal/private',
      standings: [{ playerId: 'p1', cumulativeDelta: '1200', gamesPlayed: 2, secretScore: 999 }],
    };
    const state = parseTournamentState(raw) as unknown as Record<string, unknown>;
    // Then only allow-listed keys exist on the result.
    expect(Object.keys(state).sort()).toEqual(
      [
        'activePlayerIds',
        'currentEconomics',
        'currentGameId',
        'currentGameIndex',
        'eliminatedPlayerIds',
        'gameIds',
        'gameType',
        'lastSettlement',
        'policy',
        'standings',
        'status',
        'tournamentId',
        'treasuryCarry',
      ].sort(),
    );
    expect(state).not.toHaveProperty('tournamentRootSeed');
    expect(state).not.toHaveProperty('playerEntropy');
    expect(state).not.toHaveProperty('internalEndpoint');
    const standing = (state.standings as Record<string, unknown>[])[0];
    expect(standing).not.toHaveProperty('secretScore');
  });

  it('rejects a non-object payload', () => {
    expect(() => parseTournamentState(null)).toThrow(TournamentParseError);
    expect(() => parseTournamentState('nope')).toThrow(TournamentParseError);
  });

  it('rejects a malformed standings entry (delta not a string)', () => {
    const raw = validPayload();
    const entries = raw.standings as Record<string, unknown>[];
    if (entries[0]) entries[0].cumulativeDelta = 1200;
    expect(() => parseTournamentState(raw)).toThrow(/standings\[0\]\.cumulativeDelta/);
  });

  it('rejects an unknown status', () => {
    const raw = { ...validPayload(), status: 'paused' };
    expect(() => parseTournamentState(raw)).toThrow(/status/);
  });

  it('rejects a missing required policy field', () => {
    const raw = validPayload();
    raw.policy = { baseEntryCost: '1000', carryBps: '250' };
    expect(() => parseTournamentState(raw)).toThrow(/policy\.slashBps/);
  });

  it('rejects malformed economics (playerCount not a number)', () => {
    const raw = validPayload();
    (raw.currentEconomics as Record<string, unknown>).playerCount = '2';
    expect(() => parseTournamentState(raw)).toThrow(/currentEconomics\.playerCount/);
  });
});
