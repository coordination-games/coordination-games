/**
 * Settlement gameId binding — security invariant.
 *
 * Prevents a pre-claim attack where a client supplies a `gameId` in the
 * create-game request body that differs from the Durable Object's own
 * identity (`ctx.id.name`). The DO must always bind to its own identity;
 * the body field is optional and, if present, must match exactly.
 *
 * See `packages/workers-server/src/do/resolve-gameid.ts` and the
 * `handleCreate` handler in `GameRoomDO.ts` (~L205).
 */

import { describe, expect, it } from 'vitest';
import { resolveGameId } from '../do/resolve-gameid.js';

describe('resolveGameId — settlement gameId binding', () => {
  const CTX_ID = 'game-uuid-aaaa-bbbb-cccc-dddddddddddd';

  it('bodyGameId absent → ok, binds to ctx.id.name', () => {
    const r = resolveGameId(undefined, CTX_ID);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.gameId).toBe(CTX_ID);
  });

  it('bodyGameId matches ctx.id.name → ok, binds to ctx.id.name', () => {
    const r = resolveGameId(CTX_ID, CTX_ID);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.gameId).toBe(CTX_ID);
  });

  it('bodyGameId mismatches → 400 with body "gameId mismatch" and log', () => {
    const attacker = 'attacker-controlled-uuid';
    const r = resolveGameId(attacker, CTX_ID);
    expect(r.ok).toBe(false);
    if (r.ok === false) {
      expect(r.status).toBe(400);
      expect(r.body).toBe('gameId mismatch');
      expect(r.log).toEqual({ requestedId: attacker, actualId: CTX_ID });
    }
  });

  it('empty-string bodyGameId is treated as a mismatch (not as absent)', () => {
    // Defensive: '' !== undefined, so the body explicitly claimed an id of ''.
    // That is not the same as omitting the field, and must not silently bind
    // to ctx.id.name — it's a malformed request.
    const r = resolveGameId('', CTX_ID);
    expect(r.ok).toBe(false);
    if (r.ok === false) {
      expect(r.status).toBe(400);
      expect(r.body).toBe('gameId mismatch');
    }
  });

  it('JSON null bodyGameId is rejected as a mismatch (not silently bound)', () => {
    // Defensive: when a client sends `{ "gameId": null }`, JSON.parse yields
    // the JS value `null`, which is `!== undefined`. We must reject it as a
    // malformed request rather than silently binding to ctx.id.name. The
    // helper signature is `string | undefined`, so we cast to mimic what
    // an untyped JSON body would produce at runtime.
    const r = resolveGameId(null as unknown as string | undefined, CTX_ID);
    expect(r.ok).toBe(false);
    if (r.ok === false) {
      expect(r.status).toBe(400);
      expect(r.body).toBe('gameId mismatch');
      expect(r.log).toEqual({ requestedId: null, actualId: CTX_ID });
    }
  });

  it('return type does not leak bodyGameId on the success path', () => {
    // The whole point of the fix: downstream consumers (buildSettlementPayload,
    // settleOnChain) must read the authoritative id, not the body field. The
    // helper only ever exposes gameId === ctx.id.name on the ok branch.
    const r = resolveGameId('some-other-id-that-should-be-rejected', CTX_ID);
    if (r.ok) {
      // unreachable in this case, but the type system enforces ok→gameId
      expect(r.gameId).toBe(CTX_ID);
    } else {
      expect(r.ok).toBe(false);
    }
  });
});
