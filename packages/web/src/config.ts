// API base URL — set VITE_API_URL at build time to point at the Worker domain.
// In local dev, leave it unset: Vite's proxy handles /api → localhost:3000.
const apiOrigin = (import.meta.env.VITE_API_URL as string | undefined) ?? '';

export const API_BASE = apiOrigin ? `${apiOrigin}/api` : '/api';

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
  if (apiOrigin) {
    const wsOrigin = apiOrigin.replace(/^https/, 'wss').replace(/^http/, 'ws');
    return `${wsOrigin}${path}`;
  }
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}${path}`;
}
