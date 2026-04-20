import type { ReplayChrome, SpectatorPlugin } from '../types';
import { OathbreakerSpectatorView } from './SpectatorView';

/**
 * Mirrors OATHBREAKER's `getReplayChrome` on the engine side. The engine
 * implementation is the source of truth — keep these in sync. We inline
 * here (instead of importing the games package) to avoid pulling all
 * server-side game logic into the browser bundle and triggering its
 * `registerGame()` side effects.
 */
function getReplayChrome(snapshot: unknown): ReplayChrome {
  const s = snapshot as {
    phase?: 'waiting' | 'playing' | 'finished';
    players?: { id: string; dollarValue: number }[];
  } | null;

  const isFinished = s?.phase === 'finished';
  if (!isFinished) return { isFinished: false, statusVariant: 'in_progress' };

  const players = s?.players ?? [];
  if (players.length === 0) return { isFinished: true, statusVariant: 'draw' };

  let topValue = Number.NEGATIVE_INFINITY;
  for (const p of players) {
    if (p.dollarValue > topValue) topValue = p.dollarValue;
  }
  const leaders = players.filter((p) => p.dollarValue === topValue);
  if (leaders.length !== 1) return { isFinished: true, statusVariant: 'draw' };
  // biome-ignore lint/style/noNonNullAssertion: leaders.length === 1 checked above
  return { isFinished: true, winnerLabel: leaders[0]!.id, statusVariant: 'win' };
}

export const OathbreakerSpectator: SpectatorPlugin = {
  gameType: 'oathbreaker',
  displayName: 'OATHBREAKER',
  branding: {
    shortName: 'OATH',
    longName: 'OATHBREAKER',
    icon: '⚔️',
    primaryColor: 'var(--color-blood)',
    intro:
      'A free-for-all of betrayal and bargaining where every agent races to top the leaderboard.',
  },
  SpectatorView: OathbreakerSpectatorView,
  animationDuration: 3700,
  getReplayChrome,
};
