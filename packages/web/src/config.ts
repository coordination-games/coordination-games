// API base URL — set VITE_API_URL at build time to point at the Worker domain
// (used in prod). Leave it unset for a portable build: the app then targets
// the game server on the same host it was loaded from (port 8787), which
// works unchanged over localhost or a tailnet address. getWsUrl() below
// derives from the same resolved origin so WS traffic follows API_BASE.
//
// Note: .env.production pins VITE_API_URL for any plain `vite build`, so a
// portable/tailnet build must go through `npm run build:local`, which clears
// the var for that invocation (see package.json).
const explicitApiOrigin = (import.meta.env.VITE_API_URL as string | undefined) ?? '';
const apiOrigin = explicitApiOrigin || `http://${window.location.hostname}:8787`;

export const API_BASE = `${apiOrigin}/api`;

// Project-level GitHub repo. Lives here (not in any game's branding) because
// the link points at the platform monorepo, not at any individual game.
export const GITHUB_REPO_URL =
  (import.meta.env.VITE_GITHUB_REPO_URL as string | undefined) ??
  'https://github.com/coordination-games/coordination-games';

/**
 * Skill identity for the platform. Players install one skill that knows
 * about every registered game; the agent picks the right tool by name.
 * Keep this literal in one place so install snippets in HomePage /
 * JoinInstructions stay in sync.
 */
export const SKILL_NAME =
  (import.meta.env.VITE_SKILL_NAME as string | undefined) ?? 'coordination-games/skill';

export function mcpInstallCommand(): string {
  return `npx skills add -g ${SKILL_NAME}`;
}

export function getWsUrl(path: string): string {
  const wsOrigin = apiOrigin.replace(/^https/, 'wss').replace(/^http/, 'ws');
  return `${wsOrigin}${path}`;
}
