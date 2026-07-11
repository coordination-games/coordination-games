import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runLocalTournament } from '../tournament-demo.js';
import { parseTournamentDemoPolicy } from '../tournament-demo-policy.js';

const fixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(
      resolve(import.meta.dirname, 'fixtures/tournament-policies', `${name}.json`),
      'utf8',
    ),
  );

const policies = [
  parseTournamentDemoPolicy(fixture('mint-mediator'), 'mint-mediator.json'),
  parseTournamentDemoPolicy(fixture('ash-builder'), 'ash-builder.json'),
  parseTournamentDemoPolicy(fixture('hot-opportunist'), 'hot-opportunist.json'),
];

describe('local Tragedy V2 tournament demo', () => {
  it('Given deterministic MiniMax policy fixtures, when two games run, then replay and settlement invariants hold', () => {
    const input = {
      tournamentId: 'task-12-test',
      seed: `0x${'17'.repeat(32)}`,
      playerEntropy: `0x${'29'.repeat(32)}`,
      policies,
    } as const;

    const first = runLocalTournament(input);
    const replay = runLocalTournament(input);

    expect(replay).toEqual(first);
    expect(first.games).toHaveLength(2);
    expect(new Set(first.games.map((game) => game.gameId)).size).toBe(2);
    expect(new Set(first.games.map((game) => game.gameSeed)).size).toBe(2);
    expect(new Set(first.games.map((game) => game.horizon.commitment)).size).toBe(2);
    expect(first.games.every((game) => game.horizon.verified)).toBe(true);
    expect(first.games.every((game) => game.actualRounds >= 2 && game.actualRounds <= 9)).toBe(
      true,
    );
    expect(first.games.every((game) => game.botInputSafe)).toBe(true);
    expect(
      first.games.every((game) => game.payouts.playerTotal + game.payouts.treasuryDelta === 0n),
    ).toBe(true);
    expect(first.games.every((game) => game.payouts.everyPlayerAboveEntryFloor)).toBe(true);
    expect(first.games[1]?.entryCost).toBeGreaterThanOrEqual(first.games[0]?.entryCost ?? 0n);
    expect(first.publicSpectator).not.toHaveProperty('secret');
    expect(first.publicSpectator).toMatchObject({
      status: 'completed',
      currentGameId: null,
      currentGameIndex: 1,
      currentEconomics: null,
    });
    expect(JSON.stringify(first.publicSpectator)).not.toMatch(
      /stopRound|endpoint|entropy|root|secret/i,
    );
    expect(first.transcript.some((event) => event.kind === 'horizon_reveal')).toBe(true);
    expect(first.transcript.filter((event) => event.kind === 'bot_decision')).toHaveLength(
      first.games.reduce((total, game) => total + game.actualRounds * 3, 0) + 6,
    );
  });

  it('Given equal root and entropy, when a tournament starts, then it rejects the unsafe derivation', () => {
    expect(() =>
      runLocalTournament({
        tournamentId: 'equal-seed',
        seed: `0x${'17'.repeat(32)}`,
        playerEntropy: `0x${'17'.repeat(32)}`,
        policies,
      }),
    ).toThrow(/distinct/);
  });
});
