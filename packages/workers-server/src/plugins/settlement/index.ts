/**
 * Settlement ServerPlugin (Phase 5.3).
 *
 * Thin wrapper around `SettlementStateMachine`. The state machine itself was
 * built runtime-agnostic in Phase 3.2 — its deps are exactly
 * `Pick<Capabilities, 'storage' | 'chain' | 'alarms'>`. This module adds zero
 * settlement logic; it just adapts the state machine to the `ServerPlugin`
 * contract so GameRoomDO can dispatch through `runtime.handleCall(...)` /
 * `runtime.handleAlarm(...)` instead of constructing the SM itself.
 *
 * `handleCall` surface:
 *   - `'submit'` → `sm.submit(payload)`. Returns `{ ok: true }`.
 *   - `'state'`  → `sm.getState()`. Returns the current `SettlementState | null`.
 *
 * `handleAlarm`:
 *   - kind `'settlement'` (== `SETTLEMENT_ALARM_KIND`) → `sm.tick()`.
 *
 * Construction is per-game: GameRoomDO instantiates one
 * `ServerPluginRuntime` per DO and registers `createSettlementPlugin()` on
 * first use. Worker-level plugins (ELO) live in a different runtime instance.
 */
import {
  SETTLEMENT_ALARM_KIND,
  type SettlementPayload,
  type SettlementState,
  SettlementStateMachine,
} from '../../chain/SettlementStateMachine.js';
import type { Capabilities } from '../capabilities.js';
import type { ServerPlugin } from '../runtime.js';

/** Plugin id — matches the alarm kind so GameRoomDO can route either way. */
export const SETTLEMENT_PLUGIN_ID = 'settlement';

/** Raised when `handleCall` is invoked with an unknown `name`. */
export class SettlementUnknownCallError extends Error {
  constructor(name: string) {
    super(`Unknown settlement call: ${name}`);
    this.name = 'SettlementUnknownCallError';
  }
}

/**
 * Build the Settlement ServerPlugin. The returned plugin is `register()`able
 * with a per-DO `ServerPluginRuntime` whose `caps` include `storage`,
 * `chain`, and `alarms` — the same triple the SM consumes directly.
 */
export function createSettlementPlugin(): ServerPlugin<'storage' | 'chain' | 'alarms'> {
  let sm: SettlementStateMachine | null = null;

  return {
    id: SETTLEMENT_PLUGIN_ID,
    requires: ['storage', 'chain', 'alarms'] as const,

    async init(caps: Pick<Capabilities, 'storage' | 'chain' | 'alarms'>) {
      sm = new SettlementStateMachine({
        storage: caps.storage,
        chain: caps.chain,
        alarms: caps.alarms,
        log: (event, data) => {
          // Single sink — console at the boundary makes it easy to grep
          // logs and pipe to monitoring. Mirrors the previous in-DO sink.
          console.log(`[plugin:${SETTLEMENT_PLUGIN_ID}] ${event}`, JSON.stringify(data));
        },
      });
    },

    async handleCall(name: string, args: unknown): Promise<unknown> {
      if (!sm) throw new Error('settlement plugin not initialised');
      if (name === 'submit') {
        await sm.submit(args as SettlementPayload);
        return { ok: true };
      }
      if (name === 'state') {
        const state: SettlementState | null = await sm.getState();
        return { state };
      }
      throw new SettlementUnknownCallError(name);
    },

    async handleAlarm(name: string): Promise<void> {
      // Accept the canonical alarm kind. Other kinds are not ours.
      if (name !== SETTLEMENT_ALARM_KIND) return;
      if (!sm) return;
      await sm.tick();
    },
  };
}
