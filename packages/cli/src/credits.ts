import { CREDIT_SCALE } from '@coordination-games/engine';

/**
 * Format a raw on-chain credit amount (6-decimal bigint / bigint-string) as
 * a human-readable whole-credit string.
 *
 *   "400000000" → "400"
 *   "400500000" → "400.5"
 *
 * Trailing zeros in the fractional part are stripped. An integer whole-credit
 * amount is rendered without a decimal point.
 *
 * Accepts any input that can go through `BigInt(...)` (string, number, bigint).
 * `null` / `undefined` / the string `'N/A'` pass through unchanged so callers
 * that render server errors directly still work.
 */
export function formatCreditsDisplay(raw: unknown): string {
  if (raw === null || raw === undefined) return 'N/A';
  if (typeof raw === 'string' && raw === 'N/A') return 'N/A';
  let asBig: bigint;
  try {
    // biome-ignore lint/suspicious/noExplicitAny: BigInt accepts string | number | bigint at runtime
    asBig = BigInt(raw as any);
  } catch {
    return String(raw);
  }
  const negative = asBig < 0n;
  const abs = negative ? -asBig : asBig;
  const whole = abs / CREDIT_SCALE;
  const frac = abs % CREDIT_SCALE;
  const sign = negative ? '-' : '';
  if (frac === 0n) return `${sign}${whole.toString()}`;
  // Zero-pad the fractional part to CREDIT_SCALE width, then strip trailing zeros.
  const fracStr = frac
    .toString()
    .padStart(CREDIT_SCALE.toString().length - 1, '0')
    .replace(/0+$/, '');
  return `${sign}${whole.toString()}.${fracStr}`;
}

/**
 * Convert a user-entered whole-credit amount (e.g. "100", "12.5") to raw
 * on-chain units (6 decimals).
 *
 *   "100"   → 100_000_000n
 *   "12.5"  → 12_500_000n
 *
 * Rejects negative values and more than `CREDIT_DECIMALS` fractional digits.
 * Throws on unparseable input.
 */
export function parseCreditsInput(input: string): bigint {
  const s = input.trim();
  if (!s) throw new Error('Amount is required');
  if (!/^\d+(\.\d+)?$/.test(s)) {
    throw new Error(`Invalid credit amount: ${input}`);
  }
  const [wholeStr, fracStr = ''] = s.split('.') as [string, string | undefined];
  const scaleDigits = CREDIT_SCALE.toString().length - 1; // 6
  if (fracStr && fracStr.length > scaleDigits) {
    throw new Error(`Too many decimal places (max ${scaleDigits}): ${input}`);
  }
  const paddedFrac = (fracStr ?? '').padEnd(scaleDigits, '0');
  return BigInt(wholeStr) * CREDIT_SCALE + BigInt(paddedFrac || '0');
}
