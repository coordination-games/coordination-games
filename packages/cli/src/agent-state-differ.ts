/**
 * Top-level-key diff for agent-facing state output.
 *
 * Phase 2 of the agent-envelope fix (see `docs/plans/agent-envelope-fix.md`).
 * This class used to live inside `mcp-tools.ts` — which meant the shell CLI
 * path (`coga state`, `coga wait`) bypassed it entirely and the primary agent
 * path got ZERO dedup. It lives here now so `GameClient` can apply it once
 * for every caller (shell commands, MCP handlers, programmatic bots).
 *
 * Semantics: when a top-level key's value is deep-equal to the last-seen
 * value, omit it from the returned payload and list its name in
 * `_unchangedKeys` — the agent is expected to reuse its previous observation
 * for that key. Changed keys pass through verbatim. Keys present in the
 * previous observation but absent from the current response are listed in
 * `_removedKeys` (rare, but avoids "did this vanish or stay the same?"
 * ambiguity).
 *
 * `_unchangedKeys` / `_removedKeys` themselves are presentation metadata;
 * they don't enter the diff's baseline.
 *
 * Stateful: holds one `lastSeen` baseline per instance so sequential
 * `getState` / `waitForUpdate` / `callTool` calls share a single baseline.
 * `GameClient` hydrates the baseline from `agent-persistence` on entry
 * (optional `initialLastSeen` constructor arg) and writes it back via
 * `getLastSeen()` after each successful call, so dedup survives across
 * process boundaries (two separate `coga state` invocations dedup against
 * each other).
 */

/** Shape of the per-instance baseline persisted to disk. */
export type LastSeen = Record<string, unknown> | null;

export class AgentStateDiffer {
  private lastSeen: Record<string, unknown> | null;

  constructor(initialLastSeen?: LastSeen) {
    // Accept either null or an object-shaped baseline. Anything else (array,
    // scalar, undefined) collapses to null — a corrupt persisted entry must
    // not poison the diff; we'd rather pass the next response through in
    // full and re-seed the baseline.
    if (initialLastSeen && typeof initialLastSeen === 'object' && !Array.isArray(initialLastSeen)) {
      this.lastSeen = { ...initialLastSeen };
    } else {
      this.lastSeen = null;
    }
  }

  /** Drop the baseline — next call will pass through in full and re-seed. */
  reset(): void {
    this.lastSeen = null;
  }

  /**
   * Expose the current baseline so `GameClient` can persist it back to
   * `~/.coordination/agent-state.json`. Returns `null` when there is no
   * baseline yet (fresh differ, or just after `reset()`).
   */
  getLastSeen(): LastSeen {
    return this.lastSeen;
  }

  /**
   * Take a flattened `StateResponse` (the shape downstream of
   * `flattenStateEnvelope` + `processState`) and return an agent-facing
   * projection with unchanged keys elided. Always updates `lastSeen`.
   */
  diff(result: unknown): unknown {
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      // Non-object payloads (lobby lists, guide strings) don't diff.
      return result;
    }
    const curr = result as Record<string, unknown>;
    const prev = this.lastSeen;
    // First observation — pass through in full and cache.
    if (!prev) {
      this.lastSeen = { ...curr };
      return result;
    }
    const changed: Record<string, unknown> = {};
    const unchanged: string[] = [];
    const removed: string[] = [];
    for (const [key, value] of Object.entries(curr)) {
      if (!(key in prev)) {
        changed[key] = value;
        continue;
      }
      if (deepEqualJson(value, prev[key])) {
        unchanged.push(key);
      } else {
        changed[key] = value;
      }
    }
    for (const key of Object.keys(prev)) {
      if (!(key in curr)) removed.push(key);
    }
    this.lastSeen = { ...curr };
    if (unchanged.length === 0 && removed.length === 0) return result;
    const projected: Record<string, unknown> = { ...changed };
    if (unchanged.length > 0) projected._unchangedKeys = unchanged;
    if (removed.length > 0) projected._removedKeys = removed;
    return projected;
  }
}

function deepEqualJson(a: unknown, b: unknown): boolean {
  // JSON.stringify is sufficient: state is already a plain-JSON shape
  // (no functions, no cycles, no Dates that matter for equality). Stable
  // stringification isn't required because the server produces the same
  // shape on each call for identical state.
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}
