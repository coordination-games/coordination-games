import type { SpectatorPlugin } from '../types';
import { OathbreakerSpectatorView } from './SpectatorView';

export const OathbreakerSpectator: SpectatorPlugin = {
  gameType: 'oathbreaker',
  displayName: 'OATHBREAKER',
  SpectatorView: OathbreakerSpectatorView,
  animationDuration: 3700,
};
