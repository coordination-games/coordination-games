// API base URL — set VITE_API_URL at build time to point at the Worker domain.
// In local dev, leave it unset: Vite's proxy handles /api → localhost:3000.
const apiOrigin = (import.meta.env.VITE_API_URL as string | undefined) ?? '';

export const API_BASE = apiOrigin ? `${apiOrigin}/api` : '/api';

export function getWsUrl(path: string): string {
  if (apiOrigin) {
    const wsOrigin = apiOrigin.replace(/^https/, 'wss').replace(/^http/, 'ws');
    return `${wsOrigin}${path}`;
  }
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}${path}`;
}
