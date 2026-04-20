/**
 * CtL `getReplayChrome` + `getSummaryFromSpectator` ⊆ `getSummary` invariant
 * — Phase 4.7.
 *
 * The plugin chrome is data-only (no React) so the tests just synthesize
 * minimal SpectatorState shapes — exercising the contract, not the
 * underlying engine.
 */

import { describe, expect, it } from 'vitest';
import type { CtlGameState } from '../game.js';
import { CaptureTheLobsterPlugin } from '../plugin.js';

// Minimal-shape factory — only the fields getReplayChrome / summary read.
// Returned as `unknown` so call sites narrow/cast at the plugin entry points.
function snap(overrides: Record<string, unknown>): unknown {
  return {
    turn: 5,
    maxTurns: 30,
    phase: 'in_progress' as const,
    winner: null,
    units: [
      { id: 'p1', team: 'A' },
      { id: 'p2', team: 'A' },
      { id: 'p3', team: 'B' },
      { id: 'p4', team: 'B' },
    ],
    ...overrides,
  };
}

describe('CaptureTheLobsterPlugin.getReplayChrome', () => {
  it('returns in_progress when phase != finished', () => {
    const chrome = CaptureTheLobsterPlugin.getReplayChrome(snap({}));
    expect(chrome.isFinished).toBe(false);
    expect(chrome.statusVariant).toBe('in_progress');
    expect(chrome.winnerLabel).toBeUndefined();
  });

  it('returns Team A win for finished + winner=A', () => {
    const chrome = CaptureTheLobsterPlugin.getReplayChrome(
      snap({ phase: 'finished', winner: 'A' }),
    );
    expect(chrome.isFinished).toBe(true);
    expect(chrome.statusVariant).toBe('win');
    expect(chrome.winnerLabel).toBe('Team A');
  });

  it('returns Team B win for finished + winner=B', () => {
    const chrome = CaptureTheLobsterPlugin.getReplayChrome(
      snap({ phase: 'finished', winner: 'B' }),
    );
    expect(chrome.isFinished).toBe(true);
    expect(chrome.statusVariant).toBe('win');
    expect(chrome.winnerLabel).toBe('Team B');
  });

  it('returns draw with no winnerLabel for finished + winner=null', () => {
    const chrome = CaptureTheLobsterPlugin.getReplayChrome(
      snap({ phase: 'finished', winner: null }),
    );
    expect(chrome.isFinished).toBe(true);
    expect(chrome.statusVariant).toBe('draw');
    expect(chrome.winnerLabel).toBeUndefined();
  });
});

describe('CaptureTheLobsterPlugin.getSummaryFromSpectator ⊆ getSummary (data shape)', () => {
  it('the spectator-derived summary is a subset of the full summary on a synthetic finished state', () => {
    // Build a minimal raw-state-shaped object compatible with the
    // (very thin) field accesses inside `getSummary`. We synthesize
    // both ends because the plan asks for the *invariant* — any per-key
    // value mismatch is the bug we're catching, regardless of how the
    // state was produced.
    // `getSummary` only reads a handful of fields; cast via unknown to bypass
    // the full `CtlGameState` shape requirement (which includes many fields
    // this contract test doesn't exercise).
    const fakeState = {
      turn: 7,
      phase: 'finished',
      winner: 'A',
      config: { turnLimit: 30 },
      units: [
        { id: 'p1', team: 'A' },
        { id: 'p2', team: 'A' },
        { id: 'p3', team: 'B' },
        { id: 'p4', team: 'B' },
      ],
    } as unknown as CtlGameState;
    const fakeSnapshot = snap({
      turn: 7,
      maxTurns: 30,
      phase: 'finished',
      winner: 'A',
    });
    const fullSummary = CaptureTheLobsterPlugin.getSummary(fakeState);
    const spectatorSummary = CaptureTheLobsterPlugin.getSummaryFromSpectator(fakeSnapshot);
    for (const [key, value] of Object.entries(spectatorSummary)) {
      expect(fullSummary).toHaveProperty(key);
      expect(fullSummary?.[key]).toEqual(value);
    }
  });
});
