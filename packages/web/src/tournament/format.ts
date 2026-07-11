// Presentation helpers for tournament figures. All on-wire amounts are bigint
// strings; bps are integer strings. These format for display only — they never
// re-interpret or mutate the underlying value.

/** Group a non-negative/negative integer string with thin separators: 1234567 → "1,234,567". */
export function groupInt(value: string): string {
  const negative = value.startsWith('-');
  const digits = negative ? value.slice(1) : value;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return negative ? `-${grouped}` : grouped;
}

/** Basis points string → percent label: "250" → "2.5%". */
export function bpsToPercent(bps: string): string {
  const n = Number(bps);
  if (!Number.isFinite(n)) return `${bps} bps`;
  const pct = n / 100;
  return `${Number(pct.toFixed(2))}%`;
}

/** Shorten a tx hash for display while the full value stays available to copy. */
export function shortenHash(hash: string): string {
  if (hash.length <= 14) return hash;
  return `${hash.slice(0, 8)}…${hash.slice(-6)}`;
}

/** Sign classification for coloring a delta value. */
export type Sign = 'positive' | 'negative' | 'zero';

export function signOf(value: string): Sign {
  if (value.startsWith('-')) return 'negative';
  if (/^0+$/.test(value.replace(/^\+/, ''))) return 'zero';
  return 'positive';
}
