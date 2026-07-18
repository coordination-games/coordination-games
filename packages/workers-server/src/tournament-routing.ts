export type TournamentRoutingUpdate = {
  readonly tournamentId: string;
  readonly gameId: string;
  readonly playerIds: readonly string[];
  readonly activePlayerIds: readonly string[];
  readonly completed: boolean;
};

export async function publishTournamentRouting(
  db: D1Database,
  update: TournamentRoutingUpdate,
): Promise<void> {
  const prefix = 'lobby:';
  if (!update.tournamentId.startsWith(prefix)) return;

  const lobbyId = update.tournamentId.slice(prefix.length);
  const activePlayerIds = new Set(update.activePlayerIds);
  const eliminatedPlayerIds = update.playerIds.filter((playerId) => !activePlayerIds.has(playerId));
  const terminalState = update.completed ? 'completed' : null;
  const playerRouting =
    eliminatedPlayerIds.length === 0
      ? db
          .prepare('UPDATE player_sessions SET terminal_state = ? WHERE lobby_id = ?')
          .bind(terminalState, lobbyId)
      : db
          .prepare(
            `UPDATE player_sessions
             SET terminal_state = CASE WHEN player_id IN (${eliminatedPlayerIds.map(() => '?').join(', ')})
               THEN 'eliminated' ELSE ? END
             WHERE lobby_id = ?`,
          )
          .bind(...eliminatedPlayerIds, terminalState, lobbyId);
  await db.batch([
    db
      .prepare('UPDATE lobbies SET phase = ?, game_id = ? WHERE id = ?')
      .bind(update.completed ? 'finished' : 'in_progress', update.gameId, lobbyId),
    playerRouting,
  ]);
}
