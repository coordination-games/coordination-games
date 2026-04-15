import type { SpectatorPlugin } from '../types';
import { CtlSpectatorView } from './SpectatorView';

export const CaptureTheLobsterSpectator: SpectatorPlugin = {
  gameType: 'capture-the-lobster',
  displayName: 'Capture the Lobster',
  SpectatorView: CtlSpectatorView,
  animationDuration: 5000,
};
