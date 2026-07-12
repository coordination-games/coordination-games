import { keccak256CanonicalJson } from '@coordination-games/engine';
import { GENIUS_COLORS, type GeniusColor } from './types.js';

export const GENIUS_SEQUENCE_DOMAIN = 'coordination-games/genius-fixture/v1';

export function deriveGeniusColor(seed: string, index: number): GeniusColor {
  const hash = keccak256CanonicalJson({
    domain: GENIUS_SEQUENCE_DOMAIN,
    seed,
    index,
  });
  const colorIndex = Number(BigInt(hash) % BigInt(GENIUS_COLORS.length));
  const color = GENIUS_COLORS[colorIndex];
  if (color === undefined) throw new RangeError('canonical color index is outside the palette');
  return color;
}

export function deriveGeniusSequence(seed: string, length: number): readonly GeniusColor[] {
  if (!Number.isInteger(length) || length < 0) {
    throw new RangeError('sequence length must be a non-negative integer');
  }
  return Array.from({ length }, (_, index) => deriveGeniusColor(seed, index));
}
