import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildHarnessArgs, finalStatus } from '../runs.js';

describe('buildHarnessArgs — spawn argv construction', () => {
  it('builds the live-run argv against the existing CLI entry', () => {
    // Given a resolved spec path / When building run args / Then argv is
    // exactly [<pkg>/src/index.ts, run, <spec>] — no shell, no extra flags
    const args = buildHarnessArgs('/abs/spec.yaml', 'run');
    expect(args).toHaveLength(3);
    expect(args[0]?.endsWith(path.join('src', 'index.ts'))).toBe(true);
    expect(args[1]).toBe('run');
    expect(args[2]).toBe('/abs/spec.yaml');
  });

  it('inserts --dry-run before the spec for plan-only runs', () => {
    const args = buildHarnessArgs('/abs/spec.yaml', 'dry-run');
    expect(args.slice(1)).toEqual(['run', '--dry-run', '/abs/spec.yaml']);
  });
});

describe('finalStatus — terminal state transitions', () => {
  it('maps a requested stop to stopped regardless of exit code', () => {
    // Given stopRequested / When the child exits / Then status is stopped
    expect(finalStatus(true, 0)).toBe('stopped');
    expect(finalStatus(true, 1)).toBe('stopped');
    expect(finalStatus(true, null)).toBe('stopped');
  });

  it('maps exit 0 to completed and everything else to failed', () => {
    expect(finalStatus(false, 0)).toBe('completed');
    expect(finalStatus(false, 1)).toBe('failed');
    expect(finalStatus(false, null)).toBe('failed');
  });
});
