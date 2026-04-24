import { describe, expect, it } from 'vitest';
import { CREDIT_DECIMALS, CREDIT_SCALE, credits, formatCredits, parseCredits } from '../money.js';

describe('CREDIT constants', () => {
  it('CREDIT_DECIMALS is 6 (matches USDC)', () => {
    expect(CREDIT_DECIMALS).toBe(6);
  });

  it('CREDIT_SCALE is 10^6', () => {
    expect(CREDIT_SCALE).toBe(1_000_000n);
  });
});

describe('credits()', () => {
  it('scales whole integers to raw units', () => {
    expect(credits(0)).toBe(0n);
    expect(credits(1)).toBe(1_000_000n);
    expect(credits(10)).toBe(10_000_000n);
    expect(credits(400)).toBe(400_000_000n);
  });

  it('rejects fractional values (caught at declaration time, not settlement)', () => {
    expect(() => credits(0.5)).toThrow(/non-negative integer/);
    expect(() => credits(10.5)).toThrow(/non-negative integer/);
  });

  it('rejects negative values', () => {
    expect(() => credits(-1)).toThrow(/non-negative integer/);
  });

  it('rejects NaN / Infinity', () => {
    expect(() => credits(Number.NaN)).toThrow(/non-negative integer/);
    expect(() => credits(Number.POSITIVE_INFINITY)).toThrow(/non-negative integer/);
  });
});

describe('formatCredits()', () => {
  it('formats whole-credit amounts without a decimal point', () => {
    expect(formatCredits(400_000_000n)).toBe('400');
    expect(formatCredits(10_000_000n)).toBe('10');
    expect(formatCredits(0n)).toBe('0');
  });

  it('renders fractional amounts with trailing zeros stripped', () => {
    expect(formatCredits(400_500_000n)).toBe('400.5');
    expect(formatCredits(400_500_100n)).toBe('400.5001');
    // Critical: this is the bug the shared formatter fixes — the old
    // `Number(raw / CREDIT_SCALE)` path would silently return 0 here.
    expect(formatCredits(1n)).toBe('0.000001');
    expect(formatCredits(500_000n)).toBe('0.5');
  });

  it('preserves sign for negative values', () => {
    expect(formatCredits(-10_000_000n)).toBe('-10');
    expect(formatCredits(-500_000n)).toBe('-0.5');
  });

  it('accepts strings / numbers / bigints', () => {
    expect(formatCredits('400000000')).toBe('400');
    expect(formatCredits(400_000_000)).toBe('400');
    expect(formatCredits(400_000_000n)).toBe('400');
  });

  it('passes through null / undefined / "N/A" unchanged', () => {
    expect(formatCredits(null)).toBe('N/A');
    expect(formatCredits(undefined)).toBe('N/A');
    expect(formatCredits('N/A')).toBe('N/A');
  });

  it('returns the original string on unparseable input', () => {
    expect(formatCredits('not-a-number')).toBe('not-a-number');
  });
});

describe('parseCredits()', () => {
  it('parses whole integers', () => {
    expect(parseCredits('100')).toBe(100_000_000n);
    expect(parseCredits('1')).toBe(1_000_000n);
    expect(parseCredits('0')).toBe(0n);
  });

  it('parses decimal amounts', () => {
    expect(parseCredits('12.5')).toBe(12_500_000n);
    expect(parseCredits('0.000001')).toBe(1n);
    expect(parseCredits('1.234567')).toBe(1_234_567n);
  });

  it('rejects more than CREDIT_DECIMALS fractional digits', () => {
    expect(() => parseCredits('1.1234567')).toThrow(/decimal places/);
  });

  it('rejects unparseable / negative input', () => {
    expect(() => parseCredits('')).toThrow();
    expect(() => parseCredits('abc')).toThrow();
    expect(() => parseCredits('-1')).toThrow();
  });
});

describe('format ↔ parse round-trip', () => {
  it.each(['0', '1', '100', '12.5', '0.000001', '1.234567'])('round-trips "%s"', (n) => {
    expect(formatCredits(parseCredits(n))).toBe(n);
  });
});
