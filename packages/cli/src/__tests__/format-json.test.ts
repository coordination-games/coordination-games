/**
 * Tests for the `formatJson` helper in `commands/game.ts` and the
 * `--pretty` flag wiring on shell subcommands.
 *
 * Agents get compact JSON by default; humans opt into indented output
 * via `--pretty`. The helper lives at the CLI layer (MCP path emits
 * compact unconditionally via `jsonResult` — untouched by --pretty).
 */

import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { formatJson, registerGameCommands } from '../commands/game.js';

describe('formatJson', () => {
  it('returns compact JSON when pretty=false', () => {
    const out = formatJson({ a: 1, b: [2, 3] }, false);
    expect(out).toBe('{"a":1,"b":[2,3]}');
    expect(out).not.toContain('\n');
    expect(out).not.toMatch(/\n {2}/);
  });

  it('returns pretty JSON when pretty=true', () => {
    const out = formatJson({ a: 1, b: [2, 3] }, true);
    expect(out).toContain('\n');
    expect(out).toMatch(/\n {2}"a": 1/);
    // And parseable back to the same value.
    expect(JSON.parse(out)).toEqual({ a: 1, b: [2, 3] });
  });

  it('handles primitives and nulls on both paths', () => {
    expect(formatJson(null, false)).toBe('null');
    expect(formatJson(null, true)).toBe('null');
    expect(formatJson('hi', false)).toBe('"hi"');
    expect(formatJson(42, false)).toBe('42');
  });

  it('produces byte-savings vs pretty for non-trivial objects', () => {
    const payload = {
      gameId: 'abc',
      turn: 3,
      mapStatic: {
        w: 12,
        h: 8,
        walls: [
          [1, 2],
          [3, 4],
          [5, 6],
        ],
      },
      summary: { pos: [0, 0], enemies: [{ pos: [1, 1], unitClass: 'scout' }] },
    };
    expect(formatJson(payload, false).length).toBeLessThan(formatJson(payload, true).length);
  });
});

describe('--pretty flag wiring (Commander)', () => {
  // We don't execute the actions (they'd need a wallet + network); we only
  // inspect the Command tree to confirm `--pretty` is registered on each
  // JSON-emitting subcommand. `state` also has `--fresh`, `guide` is
  // parameterized by an optional arg — none of that matters here.
  function buildProgram(): Command {
    const program = new Command();
    registerGameCommands(program);
    return program;
  }

  function hasOption(cmd: Command, flag: string): boolean {
    return cmd.options.some((o) => o.long === flag);
  }

  function findSub(program: Command, name: string): Command {
    const sub = program.commands.find((c) => c.name() === name);
    if (!sub) throw new Error(`subcommand "${name}" not found`);
    return sub;
  }

  it('registers --pretty on `state`', () => {
    const program = buildProgram();
    expect(hasOption(findSub(program, 'state'), '--pretty')).toBe(true);
  });

  it('registers --pretty on `wait`', () => {
    const program = buildProgram();
    expect(hasOption(findSub(program, 'wait'), '--pretty')).toBe(true);
  });

  it('registers --pretty on `guide`', () => {
    const program = buildProgram();
    expect(hasOption(findSub(program, 'guide'), '--pretty')).toBe(true);
  });

  it('registers --pretty on `tool`', () => {
    const program = buildProgram();
    expect(hasOption(findSub(program, 'tool'), '--pretty')).toBe(true);
  });

  it('does NOT register --pretty on non-JSON commands (lobbies, join)', () => {
    const program = buildProgram();
    expect(hasOption(findSub(program, 'lobbies'), '--pretty')).toBe(false);
    expect(hasOption(findSub(program, 'join'), '--pretty')).toBe(false);
  });
});
