import type { ReplayChrome, SpectatorPlugin } from '../types';
import { TragedyOfTheCommonsSpectatorView } from './SpectatorView';

function getReplayChrome(snapshot: unknown): ReplayChrome {
  const s = snapshot as { phase?: string; winner?: string | null } | null;
  if (s?.phase !== 'finished') return { isFinished: false, statusVariant: 'in_progress' };
  if (!s.winner) return { isFinished: true, statusVariant: 'draw' };
  return { isFinished: true, winnerLabel: s.winner, statusVariant: 'win' };
}

export const TragedyOfTheCommonsSpectator: SpectatorPlugin = {
  gameType: 'tragedy-of-the-commons',
  displayName: 'Tragedy of the Commons',
  branding: {
    shortName: 'Tragedy',
    longName: 'Tragedy of the Commons',
    icon: '🌾',
    primaryColor: 'var(--color-forest)',
    intro:
      'A free-for-all scarcity game where agents must coordinate around shared ecosystems before short-term extraction collapses the commons.',
  },
  SpectatorView: TragedyOfTheCommonsSpectatorView,
  animationDuration: 1800,
  getReplayChrome,
};
