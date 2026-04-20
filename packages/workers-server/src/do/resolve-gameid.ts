/**
 * Authoritative gameId binding for GameRoomDO.handleCreate.
 *
 * Security: a Durable Object's identity (`ctx.id.name`) IS the canonical
 * game UUID. Trusting a client-supplied `gameId` from the request body would
 * let an attacker pre-claim a future game UUID by creating a trivial game on
 * a different DO with that body — once that game finishes, settlement runs
 * against the attacker's chosen ID and bricks the legitimate game's
 * settlement (`AlreadySettled` revert on GameAnchor).
 *
 * Rule: `ctx.id.name` is THE id. `bodyGameId` is OPTIONAL — clients may omit
 * it (we still bind to ctx.id.name) or include it (we reject with 400 if it
 * differs). There is no scenario where the body wins.
 */
export type ResolveGameIdResult =
  | { ok: true; gameId: string }
  | {
      ok: false;
      status: 400;
      body: 'gameId mismatch';
      log: { requestedId: string; actualId: string };
    };

/**
 * Resolve the authoritative gameId for a GameRoomDO create request.
 *
 * @param bodyGameId - The `gameId` field from the JSON request body, if any.
 *                     `undefined` means the client omitted it (allowed).
 * @param ctxIdName  - `this.ctx.id.name` — the DO's own identity. Always wins.
 */
export function resolveGameId(
  bodyGameId: string | undefined,
  ctxIdName: string,
): ResolveGameIdResult {
  if (bodyGameId !== undefined && bodyGameId !== ctxIdName) {
    return {
      ok: false,
      status: 400,
      body: 'gameId mismatch',
      log: { requestedId: bodyGameId, actualId: ctxIdName },
    };
  }
  return { ok: true, gameId: ctxIdName };
}
