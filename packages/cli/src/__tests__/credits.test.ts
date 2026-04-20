/**
 * Credit formatting helpers — CLI-side presentation of the on-chain 6-decimal
 * scale. See `packages/engine/src/money.ts` for the canonical scale constant.
 */

import { describe, expect, it } from 'vitest';
import { formatCreditsDisplay, parseCreditsInput } from '../credits.js';

describe('formatCreditsDisplay', () => {
  it('renders raw 6-decimal amount as whole credits', () => {
    expect(formatCreditsDisplay('400000000')).toBe('400');
    expect(formatCreditsDisplay('10000000')).toBe('10');
    expect(formatCreditsDisplay(0n)).toBe('0');
  });

  it('renders fractional parts when present (stripping trailing zeros)', () => {
    expect(formatCreditsDisplay('400500000')).toBe('400.5');
    expect(formatCreditsDisplay('400500100')).toBe('400.5001');
    expect(formatCreditsDisplay('1')).toBe('0.000001');
  });

  it('handles negative amounts', () => {
    expect(formatCreditsDisplay('-10000000')).toBe('-10');
    expect(formatCreditsDisplay(-500000n)).toBe('-0.5');
  });

  it('passes null/undefined/"N/A" through as "N/A"', () => {
    expect(formatCreditsDisplay(null)).toBe('N/A');
    expect(formatCreditsDisplay(undefined)).toBe('N/A');
    expect(formatCreditsDisplay('N/A')).toBe('N/A');
  });

  it('returns raw string for unparseable input (no throw)', () => {
    expect(formatCreditsDisplay('not-a-number')).toBe('not-a-number');
  });
});

describe('parseCreditsInput', () => {
  it('scales whole-credit input to raw 6-decimal bigint', () => {
    expect(parseCreditsInput('100')).toBe(100_000_000n);
    expect(parseCreditsInput('1')).toBe(1_000_000n);
    expect(parseCreditsInput('0')).toBe(0n);
  });

  it('accepts fractional amounts up to 6 decimals', () => {
    expect(parseCreditsInput('12.5')).toBe(12_500_000n);
    expect(parseCreditsInput('0.000001')).toBe(1n);
    expect(parseCreditsInput('1.234567')).toBe(1_234_567n);
  });

  it('rejects more than 6 fractional digits (would lose precision)', () => {
    expect(() => parseCreditsInput('1.1234567')).toThrow(/decimal places/);
  });

  it('rejects negative / empty / non-numeric input', () => {
    expect(() => parseCreditsInput('')).toThrow();
    expect(() => parseCreditsInput('abc')).toThrow();
    expect(() => parseCreditsInput('-1')).toThrow();
  });

  it('round-trip: parse then format returns original (for integer inputs)', () => {
    for (const n of ['0', '1', '10', '400', '1234567890']) {
      expect(formatCreditsDisplay(parseCreditsInput(n))).toBe(n);
    }
  });
});
