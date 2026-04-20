/**
 * Registry boot-time enforcement of `CoordinationGame` required methods.
 *
 * Phase 4.7 promoted `getSummaryFromSpectator` from optional to required
 * and added the data-only `getReplayChrome`. `registerGame` rejects any
 * plugin missing either function so the failure is at plugin load (loud,
 * predictable) instead of at first replay/spectator render.
 */

import { describe, expect, it } from 'vitest';
import { type CoordinationGame, registerGame } from '../index.js';

// ---------------------------------------------------------------------------
// Minimal plugin builder — only fields registerGame reads. Tests can omit
// either required method to exercise the boot-time guard.
// ---------------------------------------------------------------------------

let testIx = 0;
function uniq(prefix: string): string {
  testIx += 1;
  return `${prefix}-${testIx}-${Date.now().toString(36)}`;
}

interface FakeOpts {
  gameType: string;
  withReplayChrome?: boolean;
  withSummaryFromSpectator?: boolean;
}

type AnyGame = CoordinationGame<unknown, unknown, unknown, unknown>;

function fakeGame(opts: FakeOpts): AnyGame {
  const base: Record<string, unknown> = {
    gameType: opts.gameType,
    version: '0.0.0-test',
    entryCost: 0n,
    createInitialState: () => ({}),
    validateAction: () => false,
    applyAction: (state: unknown) => ({ state }),
    getVisibleState: () => ({}),
    isOver: () => true,
    getOutcome: () => ({}),
    computePayouts: () => new Map(),
    buildSpectatorView: () => ({}),
  };
  if (opts.withReplayChrome) {
    base.getReplayChrome = () => ({ isFinished: false, statusVariant: 'in_progress' as const });
  }
  if (opts.withSummaryFromSpectator) {
    base.getSummaryFromSpectator = () => ({});
  }
  return base as unknown as AnyGame;
}

describe('registerGame — Phase 4.7 required-method enforcement', () => {
  it('throws when getReplayChrome is missing', () => {
    const plugin = fakeGame({
      gameType: uniq('missing-replay-chrome'),
      withSummaryFromSpectator: true,
    });
    expect(() => registerGame(plugin)).toThrow(/missing required method: getReplayChrome/);
  });

  it('throws when getSummaryFromSpectator is missing', () => {
    const plugin = fakeGame({
      gameType: uniq('missing-summary-from-spectator'),
      withReplayChrome: true,
    });
    expect(() => registerGame(plugin)).toThrow(/missing required method: getSummaryFromSpectator/);
  });

  it('throws when both are missing (first-checked is reported)', () => {
    const plugin = fakeGame({ gameType: uniq('missing-both') });
    expect(() => registerGame(plugin)).toThrow(/missing required method/);
  });

  it('succeeds when both are present', () => {
    const plugin = fakeGame({
      gameType: uniq('has-both'),
      withReplayChrome: true,
      withSummaryFromSpectator: true,
    });
    expect(() => registerGame(plugin)).not.toThrow();
  });

  it('error message names the failing game and lists both required methods', () => {
    const gameType = uniq('msg-format');
    const plugin = fakeGame({ gameType, withSummaryFromSpectator: true });
    let thrown: unknown;
    try {
      registerGame(plugin);
    } catch (err) {
      thrown = err;
    }
    expect((thrown as Error).message).toContain(gameType);
    expect((thrown as Error).message).toMatch(/getReplayChrome/);
    expect((thrown as Error).message).toMatch(/getSummaryFromSpectator/);
  });
});
