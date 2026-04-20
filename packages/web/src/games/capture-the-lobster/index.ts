import type { ReplayChrome, SpectatorPlugin } from '../types';
import { CtlSpectatorView } from './SpectatorView';

/**
 * Mirrors CtL's `getReplayChrome` on the engine side. The engine
 * implementation is the source of truth — keep these in sync. We inline
 * here (instead of importing the games package) to avoid pulling all
 * server-side game logic into the browser bundle.
 */
function getReplayChrome(snapshot: unknown): ReplayChrome {
  const s = snapshot as {
    phase?: 'pre_game' | 'in_progress' | 'finished';
    winner?: 'A' | 'B' | null;
  } | null;

  const isFinished = s?.phase === 'finished';
  if (!isFinished) return { isFinished: false, statusVariant: 'in_progress' };
  if (s?.winner === 'A' || s?.winner === 'B') {
    return { isFinished: true, winnerLabel: `Team ${s.winner}`, statusVariant: 'win' };
  }
  return { isFinished: true, statusVariant: 'draw' };
}

export const CaptureTheLobsterSpectator: SpectatorPlugin = {
  gameType: 'capture-the-lobster',
  displayName: 'Capture the Lobster',
  SpectatorView: CtlSpectatorView,
  animationDuration: 5000,
  getReplayChrome,
};
