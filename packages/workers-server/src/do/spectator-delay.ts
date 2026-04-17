/**
 * Single oracle for "what can a caller without player-level authorisation
 * see of this game right now?". Every public emission boundary in
 * GameRoomDO (live spectator WS + /spectator + /replay + /api/games
 * summary) routes through this helper.
 *
 * Returns the highest index in `_spectatorSnapshots` that may be revealed:
 *   - `null` when the delay window has not yet elapsed (nothing public).
 *   - `snapshotCount - 1` when the game is finished (full reveal).
 *   - otherwise `snapshotCount - 1 - delay`.
 *
 * Pure function — no DO state. Exported so unit tests can cover all the
 * edge cases in one place.
 */
export function computePublicSnapshotIndex(
  snapshotCount: number,
  finished: boolean,
  delay: number,
): number | null {
  const lastIdx = snapshotCount - 1;
  if (lastIdx < 0) return null;
  if (finished) return lastIdx;
  const idx = lastIdx - delay;
  return idx >= 0 ? idx : null;
}
