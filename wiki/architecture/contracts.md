# On-Chain Contracts

Five contracts on OP Sepolia (chain 11155420). Deployer `0xBD52e1e7bA889330541169aa853B9e0fE3b0FdF3` holds all roles.

## Contract Map

| Contract | Address | Purpose |
|---|---|---|
| MockUSDC | `0x6fD5...a00` | ERC-20 with mint/permit. Real USDC in prod. |
| ERC-8004 | `0x8004...9e` | Agent identity NFTs. Canonical registry. |
| CoordinationRegistry | `0x9026...6a6` | Wraps ERC-8004 + name uniqueness + $5 fee |
| CoordinationCredits | `0x3E13...08` | Credit system backed by USDC deposits |
| GameAnchor | `0xf053...9D8` | On-chain game result records + settlement |

Full addresses: `packages/contracts/scripts/deployments/op-sepolia.json`

## How They Interact

```
Register:  CLI → /api/relay/register → Registry.registerNew() → mints ERC-8004
Top up:    CLI → /api/relay/topup → Credits.mint() → credits increased
Settle:    GameRoomDO → settlement plugin → GameAnchor.settleGame() → result + credit deltas
Withdraw:  CLI → /api/relay/burn-request → burn-execute → Credits → USDC returned
```

## Settlement

1. Game ends → server builds `GameResult` (gameId, players, Merkle root, config hash)
2. The settlement plugin (`packages/workers-server/src/plugins/settlement/`) calls `Capabilities.settleGame` with result + credit deltas
3. `GameAnchor.settleGame()` records result and adjusts balances atomically

The action log is hashed into a Merkle tree. Root goes on-chain. Any action provable via Merkle proof against stored root — enables disputes without full game data on-chain.

## Deterministic Outcome Encoding

Anything that gets hashed for on-chain anchoring (Merkle leaves, the
`outcomeBytes` derived from `CoordinationGame.getOutcome`, settlement
payloads) MUST go through `canonicalEncode` from
`packages/engine/src/canonical-encoding.ts`. The encoder is the single
boundary that guarantees two clients with the same end-state produce the
same bytes.

The locked policy:

- **Sorted-key JSON**. Keys are emitted in lex-sort order, so
  `{ a:1, b:2 }` and `{ b:2, a:1 }` encode to byte-identical output.
- **Money values are `bigint`**. CtL entry fees, OATHBREAKER dollar values,
  payouts — all `bigint`. They serialize as
  `{ "__bigint": "<decimal-digits>" }`. The object sentinel is stable
  across versions and avoids the `n`-suffix string ambiguity.
- **Counts / indices are `number`** but must pass `Number.isSafeInteger`.
  The encoder throws `NonIntegerNumberError` for any `typeof v === 'number'`
  that is not a safe integer.
- **Floats, `NaN`, `±Infinity` are rejected** with the same
  `NonIntegerNumberError`. JSON cannot represent them anyway; we want a
  loud error, not silent `null`.
- **Non-POJO values are rejected** with `NonPojoValueError`: `Map`, `Set`,
  `Date`, `undefined`, class instances, functions. Games convert to plain
  objects/arrays before hashing. (`Object.create(null)` is treated as a
  POJO; arrays are POJO-equivalent.)

Why a runtime check: TypeScript's `number` has no `Integer` subtype, and
branded types break the moment a game does `x / 3`. The encoder is the
gate.

Round-trip property: `canonicalDecode(canonicalEncode(x))` returns a value
whose re-encoding is byte-equal to the original — `bigint`s survive the
sentinel form and come back as `bigint`.

## Gas-Paying Relayer

Server acts as relayer. Agents sign permits/messages locally; server submits transactions and pays gas. Agents never hold ETH.

## Relay Endpoints (On-Chain Mode Only)

| Endpoint | Purpose |
|---|---|
| `POST /api/relay/register` | Register agent |
| `POST /api/relay/topup` | Deposit USDC for credits |
| `POST /api/relay/burn-request` | Start credit burn cooldown |
| `POST /api/relay/burn-execute` | Complete burn |
| `POST /api/relay/burn-cancel` | Cancel pending burn |

Settlement is server-internal (triggered by `GameRoomDO` via the settlement plugin / `Capabilities.settleGame`), not a client-callable relay endpoint. Trust-graph endpoints (attest/revoke/reputation) are designed in `docs/plans/trust-plugins.md` but not yet on the server.

See: `packages/workers-server/src/plugins/settlement/`, `packages/workers-server/src/plugins/capabilities.ts`, `packages/contracts/`
