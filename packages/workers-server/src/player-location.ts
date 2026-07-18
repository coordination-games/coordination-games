import type { Env } from './env.js';

export type ActivePlayerLocation =
  | { readonly kind: 'lobby'; readonly lobbyId: string; readonly gameType: string }
  | {
      readonly kind: 'game';
      readonly lobbyId: string;
      readonly gameId: string;
      readonly gameType: string;
    };

export type PlayerLocation =
  | ActivePlayerLocation
  | { readonly kind: 'eliminated'; readonly lobbyId: string; readonly gameType: string }
  | { readonly kind: 'completed'; readonly lobbyId: string; readonly gameType: string };

export async function getPlayerLocation(
  playerId: string,
  env: Env,
): Promise<PlayerLocation | null> {
  const row = await env.DB.prepare(
    `SELECT l.id AS lobby_id, l.game_id, l.game_type, ps.terminal_state
     FROM player_sessions ps
     JOIN lobbies l ON l.id = ps.lobby_id
     WHERE ps.player_id = ?`,
  )
    .bind(playerId)
    .first<{
      readonly lobby_id: string;
      readonly game_id: string | null;
      readonly game_type: string;
      readonly terminal_state: 'eliminated' | 'completed' | null;
    }>();

  if (row === null) return null;
  if (row.terminal_state === 'eliminated') {
    return { kind: 'eliminated', lobbyId: row.lobby_id, gameType: row.game_type };
  }
  if (row.terminal_state === 'completed') {
    return { kind: 'completed', lobbyId: row.lobby_id, gameType: row.game_type };
  }
  if (row.game_id !== null) {
    return { kind: 'game', lobbyId: row.lobby_id, gameId: row.game_id, gameType: row.game_type };
  }
  return { kind: 'lobby', lobbyId: row.lobby_id, gameType: row.game_type };
}
