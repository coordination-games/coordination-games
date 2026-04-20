-- 0011 — settlement state (Phase 3.2): intentionally empty.
--
-- The plan's appendix reserved this slot for a `settlement_attempts`
-- observability table, but the SettlementStateMachine (Phase 3.2) keeps
-- its source of truth in DurableObject storage:
--   plugin:settlement:settlement:state    (current SettlementState)
--   plugin:settlement:settlement:payload  (the payload the machine retries)
--
-- DO storage is the single source of truth — every transition emits a
-- structured `settlement.state.transition` log, and a failed terminal also
-- calls `console.error` for monitoring. Cross-game observability comes from
-- aggregating those logs (Cloudflare Logpush / Workers Analytics Engine),
-- not from a denormalised D1 mirror that would have to be kept in sync.
--
-- Adding a D1 mirror later is a separate decision; reserving this filename
-- so future migrations stay sequential.

SELECT 1;
