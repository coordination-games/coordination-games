/**
 * Credit decimal scaling.
 *
 * Credits are stored on-chain with 6 decimals of precision, matching USDC.
 * All money values flowing through the engine — plugin-declared `entryCost`,
 * payouts, deltas, balance checks — are `bigint`s in RAW credit units
 * (1 whole credit = `CREDIT_SCALE` raw units = 1_000_000n).
 *
 * Plugins declare `entryCost` via `credits(n)` so the call site reads as
 * "n whole credits" while the stored value is already raw:
 *
 *   entryCost: credits(10),   // = 10_000_000n
 *
 * Consumer-facing surfaces (CLI `coga balance`, web balance display,
 * insufficient-credit error bodies) format raw units via `formatCredits`.
 * User-typed amounts (`coga withdraw 100`, `coga withdraw 12.5`) go through
 * `parseCredits` to become raw units.
 *
 * USDC amounts at the mint/topup boundary stay in their own raw units
 * (also 6 decimals, but scaled by the contract's internal `credits = net * 100`
 * conversion — don't conflate the two scales).
 */
export const CREDIT_DECIMALS = 6;
export const CREDIT_SCALE = 10n ** BigInt(CREDIT_DECIMALS);

/**
 * Construct a raw credit amount from a non-negative whole-credit integer.
 *
 *   credits(10)  → 10_000_000n
 *   credits(0)   → 0n
 *   credits(10.5) → throws
 *   credits(-1)   → throws
 *
 * Fractional or negative inputs throw at declaration time rather than failing
 * later at settlement. Use this in plugin `entryCost` declarations so units
 * are unambiguous at the call site.
 */
export function credits(whole: number): bigint {
  if (!Number.isInteger(whole) || whole < 0) {
    throw new Error(`credits(): expected non-negative integer, got ${whole}`);
  }
  return BigInt(whole) * CREDIT_SCALE;
}

/**
 * Format a raw on-chain credit amount (6-decimal `bigint` / bigint-string)
 * as a human-readable whole-credit string.
 *
 *   400_000_000n → "400"
 *   400_500_000n → "400.5"
 *   1n           → "0.000001"
 *   -500_000n    → "-0.5"
 *
 * Trailing zeros in the fractional part are stripped. Integer whole-credit
 * amounts are rendered without a decimal point.
 *
 * Accepts any input that can go through `BigInt(...)` (string, number,
 * bigint). `null` / `undefined` / the string `'N/A'` pass through unchanged
 * so callers that render server errors directly still work.
 */
export function formatCredits(raw: unknown): string {
  if (raw === null || raw === undefined) return 'N/A';
  if (typeof raw === 'string' && raw === 'N/A') return 'N/A';
  let asBig: bigint;
  try {
    if (typeof raw === 'bigint') asBig = raw;
    else if (typeof raw === 'number' || typeof raw === 'string') asBig = BigInt(raw);
    else if (typeof raw === 'boolean') asBig = BigInt(raw);
    else return String(raw);
  } catch {
    return String(raw);
  }
  const negative = asBig < 0n;
  const abs = negative ? -asBig : asBig;
  const whole = abs / CREDIT_SCALE;
  const frac = abs % CREDIT_SCALE;
  const sign = negative ? '-' : '';
  if (frac === 0n) return `${sign}${whole.toString()}`;
  const fracStr = frac.toString().padStart(CREDIT_DECIMALS, '0').replace(/0+$/, '');
  return `${sign}${whole.toString()}.${fracStr}`;
}

/**
 * Convert a user-entered whole-credit amount (e.g. "100", "12.5") to raw
 * on-chain units.
 *
 *   "100"   → 100_000_000n
 *   "12.5"  → 12_500_000n
 *   "0.000001" → 1n
 *
 * Rejects negative values and more than `CREDIT_DECIMALS` fractional digits.
 * Throws on unparseable input.
 */
export function parseCredits(input: string): bigint {
  const s = input.trim();
  if (!s) throw new Error('Amount is required');
  if (!/^\d+(\.\d+)?$/.test(s)) {
    throw new Error(`Invalid credit amount: ${input}`);
  }
  const [wholeStr, fracStr = ''] = s.split('.') as [string, string | undefined];
  if (fracStr && fracStr.length > CREDIT_DECIMALS) {
    throw new Error(`Too many decimal places (max ${CREDIT_DECIMALS}): ${input}`);
  }
  const paddedFrac = (fracStr ?? '').padEnd(CREDIT_DECIMALS, '0');
  return BigInt(wholeStr) * CREDIT_SCALE + BigInt(paddedFrac || '0');
}
