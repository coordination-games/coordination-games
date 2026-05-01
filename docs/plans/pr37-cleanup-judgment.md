# PR #37 cleanup judgment and remaining work

This note documents the implementation choices made while integrating Lucian's PR #37 cleanup request into `djimo/agentic-trust-integration`.

## Implemented in this branch

1. Removed local `@agentic-trust/*` file dependencies from the Coordination Games monorepo.
2. Vendored the required canonical JSON and canonical hash helpers into `packages/engine`.
3. Added engine-level `AttestationV1` and local trust evidence envelope types.
4. Added `packages/plugins/trust-projector-tragedy`, an in-repo ToolPlugin that projects public attestation relays plus visible Tragedy state into `TrustCardV1[]`.
5. Updated Tragedy of the Commons to emit public `attestation` relay envelopes for accepted round choices and timeout auto-passes.
6. Wired trust-card projection through the shared plugin path for CLI and server state surfaces.
7. Removed `GameRoomDO`'s `withVisibleTrustCards` post-processing wrapper.
8. Kept trust evidence publishing optional and gated behind `TRUST_IPFS_PUBLISH_ENABLED` plus `LIGHTHOUSE_API_KEY`.
9. Left the existing observatory spectator-DM compatibility hack unchanged, as requested.

## Engineering judgment applied

### Attestation IDs

The cleanup doc asked for deterministic attestation IDs but did not specify a helper. This implementation uses `keccak256CanonicalJson(...)` over game type, round, subject, claim type, and claim data. That gives stable IDs without adding a premature public helper. A future cleanup can extract this into an engine helper such as `deterministicAttestationId(...)` if more games start emitting attestations.

### Tragedy claim payloads

This branch emits the conservative claim type `tragedy.round_choice.v1` for accepted player choices and system timeout passes. It intentionally does not emit `tragedy.commitment_made`, `tragedy.commitment_breached`, or `tragedy.coalition_joined`, because those are not explicit mechanics in the current game and inventing them would create misleading trust semantics.

### Projector inputs

Existing plugins mostly consumed relay messages. Trust cards need both public attestations and the viewer-visible state context, so the pipeline now passes `game-state` and `game-meta` alongside `relay-messages`. The projector still treats relay attestations as the trust source and visible state as projection context/fallback.

### Reducer migration

The previous adapter derived cards directly from visible game state. The new reducer accepts public `AttestationV1` relays and visible state. When no attestation evidence exists for a visible player, it emits a viewer-visible fallback evidence reference so the UI remains useful and backwards compatible.

### Relay schema registration

The `attestation` relay schema is registered by the `trust-projector-tragedy` plugin, following the existing plugin relay-type pattern. `GameRoomDO` also rejects externally-submitted attestation relays unless their resolved scope is `all`.

## Remaining follow-up work

1. Add richer Tragedy attestations once the claim shapes are agreed:
   - `tragedy.ecosystem_impact.v1`
   - `tragedy.settlement_built.v1`
   - `tragedy.trade_offer.v1`
   - possibly `tragedy.trade_settled.v1`
2. Decide whether to promote a shared engine helper for deterministic attestation IDs.
3. Decide whether the projector's Zod schema should remain permissive with passthrough fields or become strict.
4. Add D1 attestation persistence and cross-game loading in a follow-up PR, per Lucian's follow-up plan.
5. Add agent-authored attestations through a future MCP/CLI `attest` tool.
6. Re-run a full local harness demo after merge cleanup is pushed, especially if reviewers want to see live `trustCards` and IPFS-published evidence together.

## Validation completed

- `npm run check`
- `npm run build`
- `npm test -- --run`
- `npx tsc -p packages/workers-server/tsconfig.json --noEmit`
- Targeted worker trust tests
- Grep check for removed `@agentic-trust` and `withVisibleTrustCards` references
- Oracle blocker-level review: PASS
