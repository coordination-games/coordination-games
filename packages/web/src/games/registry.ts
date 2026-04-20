import { CaptureTheLobsterSpectator } from './capture-the-lobster';
import { OathbreakerSpectator } from './oathbreaker';
import type { SpectatorPlugin } from './types';

const SPECTATOR_PLUGINS: Record<string, SpectatorPlugin> = {
  'capture-the-lobster': CaptureTheLobsterSpectator,
  oathbreaker: OathbreakerSpectator,
};

export function getSpectatorPlugin(gameType: string): SpectatorPlugin | undefined {
  return SPECTATOR_PLUGINS[gameType];
}

export function getAllGameTypes(): string[] {
  return Object.keys(SPECTATOR_PLUGINS);
}

export function getAllPlugins(): SpectatorPlugin[] {
  return Object.values(SPECTATOR_PLUGINS);
}
