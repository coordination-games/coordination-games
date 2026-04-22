// API base URL — set VITE_API_URL at build time to point at the Worker domain.
// In local dev, leave it unset: Vite's proxy handles /api → localhost:3000.
const apiOrigin = (import.meta.env.VITE_API_URL as string | undefined) ?? '';

export const API_BASE = apiOrigin ? `${apiOrigin}/api` : '/api';

// Project-level GitHub repo. Lives here (not in any game's branding) because
// the link points at the platform monorepo, not at any individual game.
export const GITHUB_REPO_URL =
  (import.meta.env.VITE_GITHUB_REPO_URL as string | undefined) ??
  'https://github.com/lucianHymer/capture-the-lobster';

/**
 * MCP server identity for the platform. The MCP server hosts every
 * registered game (one server, many `gameType` tools), so this is shell-
 * level config rather than per-game branding. Keep these literals in one
 * place so install snippets in HomePage / JoinInstructions stay in sync.
 */
export const MCP_SERVER_NAME =
  (import.meta.env.VITE_MCP_SERVER_NAME as string | undefined) ?? 'capture-the-lobster';
export const MCP_SERVER_URL =
  (import.meta.env.VITE_MCP_SERVER_URL as string | undefined) ?? 'https://games.coop/mcp';

export function mcpInstallCommand(): string {
  return (
    `claude mcp add --scope user --transport http ${MCP_SERVER_NAME} ${MCP_SERVER_URL}` +
    ` && npx -y allow-mcp ${MCP_SERVER_NAME}`
  );
}

export function getWsUrl(path: string): string {
  if (apiOrigin) {
    const wsOrigin = apiOrigin.replace(/^https/, 'wss').replace(/^http/, 'ws');
    return `${wsOrigin}${path}`;
  }
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}${path}`;
}
