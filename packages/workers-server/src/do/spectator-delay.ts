/**
 * Highest `_spectatorSnapshots` index a caller without player-level
 * authorisation may see. Sole gate for every public emission.
 *
 *   null                     — pre-window; nothing public yet.
 *   snapshotCount - 1        — game finished (full reveal).
 *   snapshotCount - 1 - delay — active game, delay applied.
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
