import type { SpectatorPlugin } from '../types';
import { ComedySpectatorView } from './SpectatorView';

export const ComedyOfTheCommonsSpectator: SpectatorPlugin = {
  gameType: 'comedy-of-the-commons',
  displayName: 'Comedy of the Commons',
  SpectatorView: ComedySpectatorView,
  animationDuration: 1200,
};
