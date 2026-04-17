import { describe, it, expect } from 'vitest';
import { computePublicSnapshotIndex } from '../do/spectator-delay.js';

describe('computePublicSnapshotIndex', () => {
  it('delay 0, 0 snapshots → null', () => {
    expect(computePublicSnapshotIndex(0, false, 0)).toBeNull();
  });

  it('delay 0, 1 snapshot, unfinished → 0', () => {
    expect(computePublicSnapshotIndex(1, false, 0)).toBe(0);
  });

  it('delay 0, 5 snapshots, unfinished → 4', () => {
    expect(computePublicSnapshotIndex(5, false, 0)).toBe(4);
  });

  it('delay 2, 0 snapshots → null', () => {
    expect(computePublicSnapshotIndex(0, false, 2)).toBeNull();
  });

  it('delay 2, 1 snapshot, unfinished → null', () => {
    expect(computePublicSnapshotIndex(1, false, 2)).toBeNull();
  });

  it('delay 2, 2 snapshots, unfinished → null', () => {
    expect(computePublicSnapshotIndex(2, false, 2)).toBeNull();
  });

  it('delay 2, 3 snapshots, unfinished → 0', () => {
    expect(computePublicSnapshotIndex(3, false, 2)).toBe(0);
  });

  it('delay 2, 5 snapshots, unfinished → 2', () => {
    expect(computePublicSnapshotIndex(5, false, 2)).toBe(2);
  });

  it('delay 2, 5 snapshots, finished → 4 (full reveal)', () => {
    expect(computePublicSnapshotIndex(5, true, 2)).toBe(4);
  });

  it('delay 50, 10 snapshots, unfinished → null', () => {
    expect(computePublicSnapshotIndex(10, false, 50)).toBeNull();
  });

  it('finished with 1 snapshot, any delay → 0', () => {
    expect(computePublicSnapshotIndex(1, true, 2)).toBe(0);
    expect(computePublicSnapshotIndex(1, true, 0)).toBe(0);
  });

  it('finished with 0 snapshots → null (cannot show what does not exist)', () => {
    expect(computePublicSnapshotIndex(0, true, 0)).toBeNull();
    expect(computePublicSnapshotIndex(0, true, 2)).toBeNull();
  });
});
