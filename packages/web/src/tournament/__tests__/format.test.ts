import { describe, expect, it } from 'vitest';
import { bpsToPercent, groupInt, shortenHash, signOf } from '../format';

describe('groupInt', () => {
  it('groups thousands', () => {
    expect(groupInt('1234567')).toBe('1,234,567');
    expect(groupInt('999')).toBe('999');
  });
  it('preserves a leading minus', () => {
    expect(groupInt('-1200')).toBe('-1,200');
  });
});

describe('bpsToPercent', () => {
  it('converts integer bps to percent', () => {
    expect(bpsToPercent('250')).toBe('2.5%');
    expect(bpsToPercent('500')).toBe('5%');
    expect(bpsToPercent('10000')).toBe('100%');
  });
});

describe('shortenHash', () => {
  it('shortens long hashes', () => {
    expect(shortenHash('0xabc123def456789000')).toBe('0xabc123…789000');
  });
  it('leaves short strings untouched', () => {
    expect(shortenHash('0xabc')).toBe('0xabc');
  });
});

describe('signOf', () => {
  it('classifies sign', () => {
    expect(signOf('150')).toBe('positive');
    expect(signOf('-150')).toBe('negative');
    expect(signOf('0')).toBe('zero');
  });
});
