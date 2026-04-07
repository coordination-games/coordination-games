// Seeded character assignment for OATHBREAKER
// Deterministic: same seed + player list = same assignments

import { CHARACTERS } from './spriteMap';

/** Simple seeded PRNG (mulberry32) */
function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Hash a string to a number for seeding */
function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return h;
}

export interface CharacterAssignment {
  characterName: string;
  /** CSS hue-rotate value for overflow (>9 players), null for first 9 */
  tint: string | null;
}

/**
 * Assign characters to players deterministically.
 * @param playerIds - Array of player IDs (order matters for determinism)
 * @param seed - Game seed string
 */
export function assignCharacters(
  playerIds: string[],
  seed: string = 'default',
): Record<string, CharacterAssignment> {
  const rng = mulberry32(hashString(seed + 'characters'));

  // Shuffle character indices
  const indices = CHARACTERS.map((_, i) => i);
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }

  const assignments: Record<string, CharacterAssignment> = {};
  playerIds.forEach((id, i) => {
    const charIdx = indices[i % indices.length];
    const wrap = Math.floor(i / CHARACTERS.length);
    assignments[id] = {
      characterName: CHARACTERS[charIdx].name,
      tint: wrap > 0 ? `hue-rotate(${wrap * 40}deg)` : null,
    };
  });

  return assignments;
}
