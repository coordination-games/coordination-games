import { CaptureTheLobsterSpectator } from './capture-the-lobster';
import { OathbreakerSpectator } from './oathbreaker';
import { TragedyOfTheCommonsSpectator } from './tragedy-of-the-commons';
import type { SpectatorPlugin } from './types';

/**
 * Registered web spectator plugins. Each plugin owns its `gameType` literal
 * — the registry derives keys from `plugin.gameType` so the IDs aren't
 * inlined twice.
 */
const REGISTERED_PLUGINS: SpectatorPlugin[] = [
  CaptureTheLobsterSpectator,
  OathbreakerSpectator,
  TragedyOfTheCommonsSpectator,
];

const SPECTATOR_PLUGINS: Record<string, SpectatorPlugin> = Object.fromEntries(
  REGISTERED_PLUGINS.map((p) => [p.gameType, p]),
);

export function getSpectatorPlugin(gameType: string): SpectatorPlugin | undefined {
  return SPECTATOR_PLUGINS[gameType];
}

export function getAllGameTypes(): string[] {
  return Object.keys(SPECTATOR_PLUGINS);
}

export function getAllPlugins(): SpectatorPlugin[] {
  return Object.values(SPECTATOR_PLUGINS);
}

/**
 * The default plugin to use when no game context is available (e.g. the
 * HomePage hero, or when the URL doesn't identify a specific game). The
 * first registered plugin wins — there is intentionally no string default
 * so adding/removing games doesn't require shell edits.
 */
export function getDefaultPlugin(): SpectatorPlugin {
  const all = getAllPlugins();
  // biome-ignore lint/style/noNonNullAssertion: registry is statically populated and never empty
  return all[0]!;
}
