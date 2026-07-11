import { describe, expect, it } from 'vitest';
import {
  applyTournamentPayouts,
  createTournamentEconomics,
  type TournamentEconomicsPolicy,
} from '../index.js';

const POLICY: TournamentEconomicsPolicy = {
  baseEntryCost: 10n,
  carryBps: 2_000,
  slashBps: 500,
};

describe('tournament economics', () => {
  it('Given a three-player base game, when treasury carry and slash are withheld, then the treasury owns exact rounded residuals', () => {
    // Given
    const economics = createTournamentEconomics({
      policy: POLICY,
      playerCount: 3,
      incomingCarry: 0n,
    });
    const basePayouts = new Map<string, bigint>([
      ['alpha', 20n],
      ['bravo', -10n],
      ['charlie', -10n],
    ]);

    // When
    const settlement = applyTournamentPayouts(
      basePayouts,
      ['alpha', 'bravo', 'charlie'],
      economics,
    );

    // Then
    expect(economics).toEqual({
      baseEntryCost: 10n,
      entryCost: 10n,
      playerCount: 3,
      basePot: 30n,
      incomingCarry: 0n,
      releasedCarry: 0n,
      carryRemainder: 0n,
      carry: 6n,
      slash: 1n,
      treasuryDelta: 7n,
    });
    expect(settlement.playerPayouts).toEqual(
      new Map([
        ['alpha', 13n],
        ['bravo', -10n],
        ['charlie', -10n],
      ]),
    );
    expect(settlement.treasuryDelta).toBe(7n);
    expect([...settlement.playerPayouts.values()].reduce((sum, delta) => sum + delta, 0n)).toBe(
      -7n,
    );
  });

  it('Given treasury carry that does not divide among active players, when the next cost is frozen, then the residual remains treasury-held', () => {
    // Given / When
    const economics = createTournamentEconomics({
      policy: POLICY,
      playerCount: 2,
      incomingCarry: 7n,
    });

    // Then
    expect(economics.entryCost).toBe(13n);
    expect(economics.releasedCarry).toBe(6n);
    expect(economics.carryRemainder).toBe(1n);
    expect(economics.basePot).toBe(26n);
    expect(economics.carry).toBe(5n);
    expect(economics.slash).toBe(1n);
    expect(economics.treasuryDelta).toBe(0n);
  });

  it('Given two consecutive games, when payouts are wrapped, then each game is zero-sum including treasury and players respect its frozen stake floor', () => {
    // Given
    const players = ['alpha', 'bravo'];
    const firstEconomics = createTournamentEconomics({
      policy: POLICY,
      playerCount: 2,
      incomingCarry: 0n,
    });
    const first = applyTournamentPayouts(
      new Map([
        ['alpha', 10n],
        ['bravo', -10n],
      ]),
      players,
      firstEconomics,
    );
    const secondEconomics = createTournamentEconomics({
      policy: POLICY,
      playerCount: 2,
      incomingCarry: firstEconomics.carry,
    });

    // When
    const second = applyTournamentPayouts(
      new Map([
        ['alpha', 12n],
        ['bravo', -12n],
      ]),
      players,
      secondEconomics,
    );

    // Then
    for (const game of [
      { economics: firstEconomics, settlement: first },
      { economics: secondEconomics, settlement: second },
    ]) {
      const playerTotal = [...game.settlement.playerPayouts.values()].reduce(
        (sum, delta) => sum + delta,
        0n,
      );
      expect(playerTotal + game.settlement.treasuryDelta).toBe(0n);
      expect(
        [...game.settlement.playerPayouts.values()].every(
          (delta) => delta >= -game.economics.entryCost,
        ),
      ).toBe(true);
    }
  });

  it('Given a zero-cost policy, when payouts are wrapped, then settlement is a total no-op', () => {
    // Given
    const economics = createTournamentEconomics({
      policy: { ...POLICY, baseEntryCost: 0n },
      playerCount: 2,
      incomingCarry: 0n,
    });

    // When
    const settlement = applyTournamentPayouts(
      new Map([
        ['alpha', 0n],
        ['bravo', 0n],
      ]),
      ['alpha', 'bravo'],
      economics,
    );

    // Then
    expect(settlement).toEqual({
      playerPayouts: new Map([
        ['alpha', 0n],
        ['bravo', 0n],
      ]),
      treasuryDelta: 0n,
      roundingResidual: 0n,
    });
  });
});
