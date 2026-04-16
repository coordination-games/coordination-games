export type GameAvailability = 'live' | 'prototype' | 'concept';
export type LobbyOptionDisplay = 'versus' | 'count';

export interface GameManifestEntry {
  gameType: string;
  displayName: string;
  shortName: string;
  tagline: string;
  availability: GameAvailability;
  accentColor: string;
  lobby?: {
    options: number[];
    optionDisplay: LobbyOptionDisplay;
    buttonLabel: string;
    metricLabel: string;
  };
}

export const PLATFORM_NAME = 'Coordination Games';
export const PLATFORM_SHORT_NAME = 'CG';
export const PLATFORM_INSTALL_COMMAND = 'npx skills add -g lucianHymer/coordination';
export const PLATFORM_GITHUB_URL = 'https://github.com/coordination-games/coordination-games';

const GAME_MANIFEST: GameManifestEntry[] = [
  {
    gameType: 'capture-the-lobster',
    displayName: 'Capture the Lobster',
    shortName: 'CtL',
    tagline: 'Team tactics under fog of war',
    availability: 'live',
    accentColor: 'var(--color-forest)',
    lobby: {
      options: [2, 3, 4, 5, 6],
      optionDisplay: 'versus',
      buttonLabel: 'Create Lobby',
      metricLabel: 'Teams',
    },
  },
  {
    gameType: 'oathbreaker',
    displayName: 'OATHBREAKER',
    shortName: 'OATH',
    tagline: 'Iterated trust under real stakes',
    availability: 'live',
    accentColor: 'var(--color-blood)',
    lobby: {
      options: [4, 6, 8, 10, 12, 16, 20],
      optionDisplay: 'count',
      buttonLabel: 'Create Lobby',
      metricLabel: 'Players',
    },
  },
  {
    gameType: 'comedy-of-the-commons',
    displayName: 'Comedy of the Commons',
    shortName: 'Comedy',
    tagline: 'Resource management, trade, and reputation',
    availability: 'prototype',
    accentColor: '#34d399',
    lobby: {
      options: [4, 5, 6],
      optionDisplay: 'count',
      buttonLabel: 'Create Lobby',
      metricLabel: 'Players',
    },
  },
  {
    gameType: 'ai-alignment',
    displayName: 'AI Alignment',
    shortName: 'Alignment',
    tagline: 'Coordination under existential pressure',
    availability: 'concept',
    accentColor: '#fb7185',
  },
];

export function getAllGameManifest(): GameManifestEntry[] {
  return GAME_MANIFEST;
}

export function getLobbyEnabledGames(): GameManifestEntry[] {
  return GAME_MANIFEST.filter((game) => game.lobby);
}

export function getGameManifest(gameType?: string | null): GameManifestEntry | undefined {
  if (!gameType) return undefined;
  return GAME_MANIFEST.find((game) => game.gameType === gameType);
}

export function getGameDisplayName(gameType?: string | null): string {
  return getGameManifest(gameType)?.displayName ?? 'Unknown Game';
}

export function formatLobbyOption(game: GameManifestEntry, value: number): string {
  if (!game.lobby) return String(value);
  return game.lobby.optionDisplay === 'versus' ? `${value}v${value}` : String(value);
}

export function buildJoinPrompt(lobbyId: string, gameType?: string | null): string {
  return `Join lobby ${lobbyId} in ${PLATFORM_NAME} and play ${getGameDisplayName(gameType)}, please!`;
}
