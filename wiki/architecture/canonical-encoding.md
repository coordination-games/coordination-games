# Canonical Encoding
> If you're writing a `CoordinationGame`, the shape of your `TState` and `TOutcome` is constrained by one rule: the encoder that produces the bytes anchored on-chain must give two clients with semantically-identical values byte-identical output. This doc tells you exactly what's allowed in those values and what to do about the obvious things that aren't.

## Why

Two clients running the same game off the same action log have to derive the same `outcomeBytes` for the on-chain Merkle anchor and the spectator/replay verification path to mean anything. JavaScript makes this hard for free reasons: `JSON.stringify` walks object keys in insertion order, silently drops `Map` and `Set` to `{}`, has no `bigint` representation, and accepts `NaN` as `null` instead of refusing it. Any one of those produces an `outcomeBytes` that depends on which build constructed the value — exactly the failure mode an on-chain anchor is supposed to rule out.

The scar that pinned this in place: CtL's `playerStats` was originally a `Map<playerId, stats>`. `JSON.stringify(map)` returns `'{}'`. Every CtL outcome was anchored on-chain with empty player stats — the bug shipped, the on-chain payload was wrong, and no test caught it because in-process round-trips of the JS value still looked right. The repair was two-pronged: change `playerStats` to a POJO `Record`, and replace `JSON.stringify` with `canonicalEncode`, which **throws `NonPojoValueError`** if anyone re-introduces a `Map` (`packages/workers-server/src/__tests__/outcome-canonical-encode.test.ts:1`). Loud failure beat silent corruption; that's the design pressure.

The encoder lives at one file (`packages/engine/src/canonical-encoding.ts`), is called at the JS↔EVM boundary (`packages/workers-server/src/chain/onchain-relay.ts:302`), and is the single place a game-author value crosses into bytes-that-go-on-chain. Treat it as a type system that runs at hash time.

## How

**The function.** `canonicalEncode(value: unknown): Uint8Array` (`packages/engine/src/canonical-encoding.ts:167`) walks the value, validates every node, and returns sorted-key UTF-8 JSON bytes. `canonicalDecode(bytes): unknown` is the inverse — JSON parse, then restore `bigint` from the sentinel form.

What gets encoded vs not:

- **Strings, booleans, `null`** — encoded as themselves.
- **`number`** — encoded only if `Number.isFinite(value) && Number.isSafeInteger(value)`. Anything else (`1.5`, `NaN`, `±Infinity`, `MAX_SAFE_INTEGER + 1`) throws `NonIntegerNumberError` with the offending key path (`canonical-encoding.ts:91-95`). Use `number` only for counts and indices.
- **`bigint`** — serialised as the sentinel object `{ "__bigint": "<decimal-digits>" }` (`:86-88`). The sentinel survives `JSON.parse` as a regular object; `canonicalDecode` recognises it and reconstitutes the `bigint`. **All money values are `bigint`** — entry costs, payouts, deltas. Use the `credits(n)` helper from `@coordination-games/engine/money.ts` to construct from whole-credit integers; never `Number(rawUnits)`.
- **Arrays** — walked in index order (`:113-115`), so element order is preserved.
- **POJOs** — walked in lex-sorted key order (`:118-124`); insertion order does not matter. Both `Object.prototype` and null-prototype objects (`Object.create(null)`) count as POJO (`:52-56`).
- **Everything else** — `Map`, `Set`, `Date`, `undefined`, class instances, functions, symbols — throws `NonPojoValueError` with the offending key path and the constructor name (`:108-128`). The error is intentional: silently dropping these is exactly the bug that shipped on CtL.

**The bigint sentinel.** `{ "__bigint": "1234" }` was chosen over the obvious alternatives for stability:

- The `1234n` JS literal isn't JSON.
- An `n`-suffix string (`"1234n"`) collides with any string-typed game field happening to end in `n`.
- A type tag like `"$bigint:1234"` collides with any string starting with that prefix.

A single-key object with the reserved key `__bigint` whose value is a decimal-digit string (`/^-?\d+$/`, `:75`) is unambiguous — no game field is shaped like that, and the `isBigintSentinel` check rejects anything that isn't exactly that one shape.

**Round-trip property.** The encoder's contract is `canonicalEncode(canonicalDecode(canonicalEncode(x)))` is byte-equal to `canonicalEncode(x)` (`:179-180`). That's stronger than "decode is inverse of encode" — it means a value that survives one round-trip will keep producing the same bytes forever, which is what an on-chain Merkle anchor needs.

**Where it's called.** Three sites today, all inside the engine/server layer — game authors never call it directly:

- `packages/workers-server/src/chain/onchain-relay.ts:302` — `outcomeBytes = toHex(canonicalEncode(payload.outcome))` for `GameAnchor.settleGame`.
- `packages/workers-server/src/__tests__/outcome-canonical-encode.test.ts` — regression lock pinning the CtL `Map → {}` failure.
- `packages/engine/src/__tests__/canonical-encoding.test.ts` — full policy test suite.

Anything you write that ends up in `getOutcome(state)`, in the action log used for the Merkle root, or in any future on-chain anchored payload, will pass through `canonicalEncode`. Write to that constraint from day one of the game.

**How to test your game's payload.** The tests at `packages/engine/src/__tests__/canonical-encoding.test.ts` are the unit-level coverage; for game-level coverage, mirror the CtL pattern at `packages/workers-server/src/__tests__/outcome-canonical-encode.test.ts`:

1. Build a representative `TOutcome` with every variant your game can produce.
2. `canonicalEncode(outcome)` — should not throw. If it throws `NonPojoValueError`, you have a `Map`/`Set`/`Date`/class somewhere; if it throws `NonIntegerNumberError`, you have float math leaking into a count.
3. `canonicalDecode(canonicalEncode(outcome))` deep-equals the original (modulo `bigint` survival — they come back as `bigint`).
4. Encode the same outcome twice with different key insertion orders; assert byte-equal.
5. Negative test: insert a `Map` into one field and assert the encoder throws.

That's enough coverage to catch the `JSON.stringify(Map) → '{}'` class of failure before it ships.

## Edge cases & gotchas

- **`undefined` is not encodable, even as a property value.** `canonicalEncode({ x: undefined })` throws (`canonical-encoding.ts:103`); JSON has no representation for it and silently dropping the key would be one more "looks fine in JS, breaks on chain" trap. If a field is optional, omit the key entirely (`if (cond) out.x = …`); don't set it to `undefined`.
- **`number` vs `bigint` is a *meaning* distinction, not a size distinction.** Counts, indices, turn numbers, score deltas-in-points, ranks → `number` (must be safe-integer). Anything denominated in credits / money / on-chain raw units → `bigint`, always, even if it'd fit in `number`. The encoder doesn't know which is which; the policy is enforced by the `credits()` helper at construction (`packages/engine/src/money.ts:38`) and by code-review on `getOutcome`.
- **Floats sneak in via division.** `1 / 3 === 0.3333…` is the most common offender. OATHBREAKER's pre-Phase-3.3 `dollarPerPoint = totalCreditsInvested / totalSupply` shipped, tripped the zero-sum invariant, and was the trigger for moving to `bigint` math everywhere (`packages/games/oathbreaker/src/types.ts:206-213`). If you find yourself writing `/` on a money quantity, stop — use `bigint` floor division and assign the remainder to a deterministic recipient (the OATHBREAKER pattern: highest-rank player gets the floor remainder).
- **Counts that should be integers but accumulated through floats.** `Math.floor(x)` before assigning into a `number` field that ends up in `getOutcome`. OB's `OathOutcome.totalPrinted / totalBurned / finalSupply` are explicitly "floored to integers for `canonicalEncode` safety" (`packages/games/oathbreaker/src/types.ts:229`). A `Number.isSafeInteger`-failing value at outcome time is a bug in your accumulator, not a problem to gate at the encoder boundary.
- **`Object.create(null)` is fine.** The encoder treats null-prototype objects as POJO-equivalent (`canonical-encoding.ts:55`, tested at `__tests__/canonical-encoding.test.ts:202-208`). A `class Foo {}` instance is not — even if it has only data fields. The check is on the prototype, not the field shape.
- **Nested non-POJOs are caught with their full key path.** `canonicalEncode({ outer: { bag: new Map() } })` throws `NonPojoValueError` with `path === 'outer.bag'` and `ctor === 'Map'` (`__tests__/canonical-encoding.test.ts:191-200`). Use the path to find the offender; don't grep the whole codebase for `new Map`.
- **The bigint sentinel collides with a literal `{ __bigint: 'foo' }` object.** If a game emits a POJO whose only key is the literal string `__bigint` and whose value is a digit-string, `canonicalDecode` will mis-restore it as a `bigint` (`canonical-encoding.ts:140-142`). The sentinel detector is strict enough (`/^-?\d+$/`) that the collision is narrow, but don't pick that key for any game field. Pretend it's reserved.
- **`JSON.stringify` is still used for the action-log merkle leaves.** `kickOffSettlement` builds leaves with `actionData: JSON.stringify(e.action)` (`packages/workers-server/src/do/GameRoomDO.ts:1219`), not `canonicalEncode`. That's load-bearing-but-imperfect — it works because action objects today are insertion-order-stable in the same isolate, but it's a future tightening. If you're adding a new action type with a `Map` or a `Date`, fix it at the action shape (POJO + `bigint`/safe-integer `number`), don't rely on `JSON.stringify`.
- **`canonicalEncode(undefined)` at top level throws too.** If your `getOutcome` could ever return `undefined` (it shouldn't — `isOver(state)` must be true before it's called), you'll see the error at settlement time instead of at outcome time. Defensive: write `getOutcome` to throw on its own preconditions.

## Pointers

- `packages/engine/src/canonical-encoding.ts` — the encoder/decoder, sentinel handling, error classes (lines 25-43, 49, 167, 182).
- `packages/engine/src/__tests__/canonical-encoding.test.ts` — full policy test suite; copy-paste this for your game's outcome.
- `packages/workers-server/src/__tests__/outcome-canonical-encode.test.ts` — the CtL regression-lock pattern, scoped to a real outcome shape.
- `packages/workers-server/src/chain/onchain-relay.ts:302` — the only encoder callsite that produces on-chain bytes.
- `packages/engine/src/types.ts:198` — `getOutcome` doc comment, the policy summary at the interface boundary.
- `packages/games/oathbreaker/src/types.ts:206` — the `dollarPerPoint` scar comment, why money is `bigint`.
- `packages/engine/src/money.ts` — `credits(n)`, `formatCredits`, `parseCredits`; the construction-time guard.
- [`contracts.md`](contracts.md) — the settlement flow that consumes `outcomeBytes` and the `GameAnchor.settleGame` shape it lands in.
- [`credit-economics.md`](credit-economics.md) — why money is `bigint` end-to-end and how `computePayouts` plays into the encoder.
- `docs/building-a-game.md` — game-author tutorial, calls out the encoder constraints inline.
