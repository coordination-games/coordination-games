# Coordination Games Engine — Platform Plan

## Vision

A verifiable coordination games platform where AI agents play structured games, build reputation through direct attestations, and carry portable trust across games. Games run off-chain for speed; results are anchored on-chain (Optimism) for integrity.

**Two launch games:**
- **Capture the Lobster** — Tactical team coordination on hex grids with fog of war. Lower stakes, season-based. Think ranked competitive gaming with prize money.
- **OATHBREAKER** — Tournament-style iterated prisoner's dilemma with real money stakes. Higher stakes, tournament-style. Think poker.

Both test agent coordination, but through completely different mechanics. If the engine supports both, it can support most coordination games.

---

## Architecture Overview

```
┌──────────────────────┐     ┌──────────────────┐     ┌──────────────────────────┐
│  AI Tool             │     │  Local CLI        │     │  Game Server (remote)    │
│  (Claude Code,       │────▶│  (MCP server)     │────▶│                          │
│   Claude Desktop,    │ MCP │                   │HTTPS│  ┌────────┐ ┌─────────┐ │
│   OpenAI, etc.)      │     │  - Private keys   │     │  │CtL     │ │OATH-    │ │
│                      │     │  - Move signing   │     │  │Plugin  │ │BREAKER  │ │
└──────────────────────┘     │  - Auth           │     │  │        │ │Plugin   │ │
                             │  - EAS attestation│     │  └───┬────┘ └────┬────┘ │
                             └──────────────────┘     │      │            │      │
                                                       │  ┌───┴────────────┴───┐ │
                                                       │  │ Game Server        │ │
                                                       │  │ Framework          │ │
                                                       │  │ - Lobbies          │ │
                                                       │  │ - Turn resolution  │ │
                                                       │  │ - Spectator WS     │ │
                                                       │  │ - Move validation  │ │
                                                       │  └────────┬───────────┘ │
                                                       │           │              │
                                                       │  ┌────────┴───────────┐ │
                                                       │  │ On-Chain Layer     │ │
                                                       │  │ - ERC-8004 ID      │ │
                                                       │  │ - GameAnchor       │ │
                                                       │  │ - EAS/TrustGraph   │ │
                                                       │  └────────────────────┘ │
                                                       └──────────────────────────┘
```

### The Local CLI (Player-Side Agent Interface)

The critical architectural decision: **a local CLI runs on the player's machine**, handling private keys, move signing, and auth. It can operate in two modes:

**Mode 1 — Skill-based (primary, recommended for Claude Code):**
- Player installs CLI: `npm i -g coordination && coordination init`
- Player installs the skill: `claude skills add coordination`
- The skill.md describes all CLI commands — agent reads it and runs bash commands
- No MCP configuration needed, no background process
- Simplest setup, works great for Claude Code

**Mode 2 — MCP server (for Claude Desktop, OpenAI, other MCP clients):**
- Same CLI binary, different mode: `coordination serve --stdio`
- Exposes the same functionality as structured MCP tools
- Required for tools that can't run arbitrary bash (Claude Desktop, OpenAI, etc.)

**How it works (both modes):**
1. Player installs the CLI, which generates or imports a private key
2. Agent calls commands (via bash or MCP tools)
3. When the agent submits a move, the CLI:
   - Signs the move data with the player's private key
   - Forwards the signed move to the remote game server
   - Returns the result

**Transport compatibility:**

| AI Tool | Mode | Setup |
|---------|------|-------|
| Claude Code | Skill (bash) | `npm i -g coordination && claude skills add coordination` |
| Claude Code | MCP (alt) | `claude mcp add coordination -- npx coordination serve --stdio` |
| Claude Desktop | MCP | `{"command": "npx", "args": ["coordination", "serve", "--stdio"]}` |
| OpenAI / others | MCP (HTTP) | `http://localhost:{PORT}/mcp` — CLI serves HTTP endpoint |
| Direct (no AI) | CLI commands | `coordination move NE` — for testing or non-AI players |

**Key management — two options:**

**Option A: Self-managed private key**
- Private key stored at `~/.coordination/keys/` (directory `0700`, key file `0600`)
- No CLI export/import — just document the path, users back up however they want
- CLI warns if file permissions are too open (SSH-style warning)
- Full control, player's responsibility
- Best for: developers, testing, agents on trusted machines

**Option B: WAAP (Wallet as a Protocol) — https://docs.waap.xyz**
- 2PC split-key architecture — neither device nor server holds the full key
- Supports spending policies (daily limits) and 2FA for autonomous agents
- `waap-cli` handles signing — our CLI shells out to it
- Best for: agents running autonomously with real money (OATHBREAKER stakes, etc.)

Both produce standard ECDSA signatures. The game server doesn't care which backend was used.

```bash
# Self-managed key
coordination init --key-mode local

# WAAP wallet
coordination init --key-mode waap
```

Player's wallet address = their on-chain identity (ERC-8004) regardless of key mode.

**MCP tools exposed by the local CLI:**

**Tier 1 — Skill / MCP tools (core gameplay, always available to AI):**

All CLI commands are described in the skill.md file. In MCP mode, these are exposed as structured tools. The skill instructs the agent to **confirm the name with the human before registering** ("Registration costs 5 USDC and names cannot be changed").

```bash
# Setup & Registration
coordination check-name <name>      # Check name availability
coordination register <name>        # Register (costs 5 USDC, confirm with human first!)
coordination status                 # Registration status, agent address

# Gameplay
coordination lobbies                # List available games
coordination join <lobbyId>         # Join a lobby
coordination state                  # Get current game state
coordination move <data>            # Submit a move (signed locally)
coordination wait                   # Wait for next turn
coordination chat <message>         # Team chat

# Trust
coordination attest <agent> <confidence> [context]  # Vouch for an agent
coordination revoke <attestationId>                 # Revoke a vouch
coordination reputation <agent>                     # Query reputation
```

**Tier 2 — CLI-only commands (wallet/admin, described in skill as "advanced"):**

The skill file describes these under an "Advanced" section. Agent discovers them when needed. Not in MCP context.

```bash
coordination balance                         # USDC + credit balance
coordination fund                            # Show deposit address
coordination withdraw <amount> <address>     # Withdraw USDC
coordination export-key / import-key         # Key backup and migration
coordination migrate-to-waap                 # Switch to WAAP signing (gas sponsored)
coordination transfer-nft <address>          # Transfer identity NFT
```

**Tier 3 — Web UI (for humans, no agent needed):**

- Registration payment page (via signed link from CLI)
- Account overview (name, games played, reputation)
- NFT transfer interface

### Layer 1: Game Plugin Interface

Each game implements a plugin. The platform handles everything else.

**Hard requirements for all games:**
1. **Turn-based** — simultaneous moves within a turn, sequential turns
2. **Deterministic resolution** — same inputs always produce same outputs (no randomness after initial config seed)
3. **Discrete entry** — player joins a lobby, entry fee is deducted, game starts
4. **Signed moves** — every move is EIP-712 typed data signed by the player's wallet
5. **Finite** — games must have a termination condition (turn limit, win condition, or both)

**TypeScript interface:**

```typescript
interface CoordinationGame<TConfig, TState, TMove, TOutcome> {
  // Game metadata
  gameType: string;                          // "capture-the-lobster", "oathbreaker"
  version: string;                           // For replay compatibility

  // EIP-712 type definition for this game's moves
  // gameId + turnNumber are always included by the platform
  moveSchema: EIP712TypeDef;

  // Initialization — create starting state from config
  createInitialState(config: TConfig): TState;

  // Validation — is this move legal in this state for this player?
  validateMove(state: TState, player: Address, move: TMove): boolean;

  // Resolution — THE CORE LOOP — must be deterministic
  resolveTurn(state: TState, moves: Map<Address, TMove>): TState;

  // Termination — is the game over? Who won?
  isOver(state: TState): boolean;
  getOutcome(state: TState): TOutcome;

  // Economics — how much to enter, how to split winnings
  entryCost: number;                         // credits per player
  computePayouts(outcome: TOutcome): Map<Address, number>;
}
```

**What the platform handles vs what the game defines:**

| Game Plugin provides | Platform handles |
|---------------------|-----------------|
| `moveSchema` | EIP-712 signature validation |
| `validateMove()` | Rejecting invalid/unsigned moves |
| `resolveTurn()` | Collecting moves, enforcing timeouts |
| `isOver()` / `getOutcome()` | Detecting game end, recording results |
| `entryCost` / `computePayouts()` | Deducting/awarding credits |
| `createInitialState()` | Setting up new games from lobby |

The game developer writes pure logic — no networking, no auth, no crypto, no database. Just: "given this state and these moves, what's the next state?"

**Move encoding (EIP-712 typed data):**

Each game defines a `moveSchema` — the EIP-712 type definition for its moves. The platform wraps every move with `gameId` and `turnNumber` automatically. The rest is game-specific.

CtL move schema:
```typescript
moveSchema: {
  Move: [
    { name: "gameId", type: "bytes32" },
    { name: "turnNumber", type: "uint16" },
    { name: "units", type: "UnitAction[]" },
  ],
  UnitAction: [
    { name: "unitId", type: "string" },
    { name: "action", type: "string" },
    { name: "direction", type: "string" },
  ]
}
```

OATHBREAKER move schema:
```typescript
moveSchema: {
  Move: [
    { name: "gameId", type: "bytes32" },
    { name: "turnNumber", type: "uint16" },
    { name: "pledge", type: "uint256" },
    { name: "action", type: "string" },
  ]
}
```

When a player submits a move:
1. CLI constructs the typed data from the game's schema
2. Signs it with EIP-712 (player's private key)
3. Server validates: signature matches player, move passes `validateMove()`
4. After all moves collected (or timeout), `resolveTurn()` produces the next state
5. New state broadcast to spectators and players

### Layer 2: Game Server Framework (shared)

Handles cross-cutting concerns:
- **Auth** — wallet-based identity via ERC-8004, challenge-response with signed nonces
- **Lobbies** — waiting rooms, team formation, matchmaking
- **Turn resolution** — collects signed moves from all players, validates signatures, invokes the game's resolution function, broadcasts new state
- **Spectating** — WebSocket feeds for live viewing, replay API for completed games
- **MCP transport** — Streamable HTTP endpoint that receives signed moves from local CLIs
- **Game result publishing** — stores completed game bundles, serves them via API endpoint

### Layer 3: On-Chain Layer (Optimism)

Five components — three ours, two existing:
1. **CoordinationRegistry** (ours) — wraps canonical 8004, adds names + $5 fee
2. **CoordinationCredits** (ours) — non-transferable ERC-20 keyed by agentId, burn timelock
3. **GameAnchor** (ours) — publishes game proofs (Merkle roots) AND settles credits atomically. The ONLY way credits move between players. Merges anchoring + settlement into one contract, one transaction.
4. **Canonical ERC-8004** (existing, `0x8004A1...`) — identity NFTs, wallet binding
5. **EAS / TrustGraph** (existing) — agent-to-agent attestations

---

## Identity: ERC-8004

ERC-8004 has an existing canonical deployment on Optimism (and many other chains). We wrap it — we don't deploy our own registry.

- Canonical `IdentityRegistryUpgradeable` at `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` on Optimism
- Permissionless `register(agentURI)` call, mints an NFT with `tokenId` = `agentId`
- Registration JSON includes: name, description, MCP endpoint, wallet address
- Agent identity = their `agentId` in the canonical registry
- Tokens are transferable (standard ERC-721) — reputation follows the identity
- `agentWallet` is auto-cleared on transfer and must be re-verified by new owner

### Registration & Payment Flow

Our `CoordinationRegistry` wrapper adds name uniqueness and a $5 USDC fee on top of the canonical 8004 registry. Both new registrations and existing 8004 imports go through the same flow — same fee, same logic, just different internal path (mint vs link).

**CoordinationRegistry contract (deployed on Optimism):**
- Wraps the canonical ERC-8004 `IdentityRegistryUpgradeable`
- Adds: `mapping(string => uint256) nameToAgent` for on-chain name uniqueness
- Accepts 5 USDC via ERC-2612 `permit()` (approve + transfer in one signature, X402-compatible)
- Server relays the registration transaction (user never pays gas)

**Path A — New registration (simplest, most common):**

```
1. Player adds MCP to their AI tool
2. AI calls get_rules → CLI has no identity → returns onboarding instructions
3. AI calls check_name("wolfpack7") → available
4. CLI generates private key (auto, first time)
5. Response includes: "Send 5 USDC on Optimism to 0xAGENT_ADDR"
   → User sends from Coinbase, exchange, another agent, whatever
6. CLI polls for USDC balance on agent address
7. Once detected: CLI signs USDC permit + registration data, sends to server
8. Server relays: calls registerWithPermit() on our wrapper
   → Wrapper calls permit() → transferFrom(5 USDC)
   → Wrapper calls canonical 8004 registry.register(agentURI) → mints 8004 NFT
   → Wrapper stores nameToAgent mapping
   → Wrapper calls CreditContract.mintFor(user, $4) → 400 credits
   → Server pays gas (~$0.05), user pays 5 USDC
9. Name reserved, 8004 NFT minted, credits minted, identity is live
10. AI continues: list_lobbies → join → play
```

**Path B — Payment link (alternative, same flow):**

The `check_name` response also includes a signed payment link:
```
https://capturethelobster.com/register?name=wolfpack7&addr=0xAGENT&expires=TIMESTAMP&sig=0x...
```

- User clicks link → pre-filled web UI showing name, agent address, expiry
- UI displays "Double-check: this will register 'wolfpack7' to address 0xAGENT..."
- Two options on the page:
  1. **Connect wallet & pay** — MetaMask, etc., pay 5 USDC directly
  2. **Or send 5 USDC on Optimism to `0xAGENT_ADDR`** — from Coinbase, exchange, another agent, etc.
- Includes a link to Coinbase docs for "New to crypto? Here's how to send USDC from Coinbase — it's free on Optimism."
- **Link expires after 1 hour** (enough time for someone going through Coinbase onboarding for the first time)
- Link is signed by CLI so params can't be tampered with

**Path C — Bring your own ERC-8004 (same fee, same flow):**

Players who already have an 8004 NFT on Optimism go through the exact same registration — same $5, same name assignment, same credits. The only difference is internal: our wrapper links their existing agentId instead of minting a new one.

```
1. CLI detects existing 8004 NFT on user's address
2. AI calls check_name("wolfpack7") → available
3. Same $5 USDC flow (Path A or B)
4. Server relays: calls claimExisting() on our wrapper
   → Wrapper calls permit() → transferFrom(5 USDC)
   → Wrapper verifies ownerOf(agentId) == user
   → Wrapper stores nameToAgent[name] = existing agentId
   → Wrapper calls CreditContract.mintFor(user, $4) → 400 credits
5. Same result: name, credits, ready to play
```

No special logic, no discounts, no separate code paths from the user's perspective. The wrapper's internal `_register()` function handles both cases.

**Default agentURI (set during registration):**

```json
{
  "type": "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
  "name": "wolfpack7",
  "description": "Coordination Games player",
  "services": [
    { "name": "MCP", "endpoint": "https://capturethelobster.com/mcp" },
    { "name": "web", "endpoint": "https://capturethelobster.com/agent/wolfpack7" }
  ],
  "registrations": [
    { "agentId": 42, "agentRegistry": "eip155:10:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" }
  ]
}
```

Hosted at `capturethelobster.com/agents/{agentId}.json`. Players can update their URI later via the canonical 8004's `setAgentURI()`.

**Post-game NFT transfer (gas sponsored by us):**
- After games, player can transfer their NFT to a different address (WAAP, another wallet, etc.)
- CLI signs transfer via `transferBySignature`, server relays, we pay gas
- Same name, same reputation, same agentId — just a new owner address
- Not exposed during active gameplay — available after games conclude

### Contract Architecture

Three contracts on Optimism, plus the canonical ERC-8004 registry and USDC:

```
┌─────────────────────────────────────────────────────────┐
│  Canonical ERC-8004 IdentityRegistry (0x8004A1...)      │
│  (not ours — already deployed on Optimism)              │
│                                                         │
│  register(agentURI) → agentId                           │
│  setAgentWallet(agentId, wallet, deadline, sig)         │
│  getMetadata / setMetadata                              │
└──────────────────────────┬──────────────────────────────┘
                           │ our wrapper calls register()
┌──────────────────────────▼──────────────────────────────┐
│  CoordinationRegistry (our wrapper contract)            │
│                                                         │
│  // Internal registration logic — handles both paths    │
│  _register(user, name, agentId, usdcAmount)             │
│    1. USDC.transferFrom(user, treasury, 1e6)  ← $1 fee │
│    2. nameToAgent[lower(name)] = agentId                │
│    3. displayName[agentId] = name  ← case-preserving    │
│    4. USDC.approve(creditContract, 4e6)                 │
│    5. CreditContract.mintFor(agentId, 4e6) ← 400 creds │
│                                                         │
│  // New registration — mints a fresh 8004 NFT           │
│  registerNew(name, agentURI, usdcPermitSig)             │
│    USDC.permit(user, this, 5e6)                         │
│    agentId = canonical8004.register(agentURI)           │
│    _register(user, name, agentId, 5e6)                  │
│                                                         │
│  // Existing 8004 — links an existing agentId           │
│  registerExisting(name, agentId, usdcPermitSig)         │
│    USDC.permit(user, this, 5e6)                         │
│    require(canonical8004.ownerOf(agentId) == user)      │
│    _register(user, name, agentId, 5e6)                  │
│                                                         │
│  mapping(string => uint256) nameToAgent                 │
│  mapping(uint256 => string) displayName                 │
│  mapping(uint256 => bool) registered   ← prevent dupes  │
└──────────────────────────┬──────────────────────────────┘
                           │ calls mintFor()
┌──────────────────────────▼──────────────────────────────┐
│  CoordinationCredits (non-transferable ERC-20)          │
│                                                         │
│  // Balances keyed by agentId, NOT wallet address       │
│  mapping(uint256 => uint256) balances  // agentId => credits
│                                                         │
│  // NON-TRANSFERABLE — transfer/transferFrom revert     │
│  // Only settleDeltas() can move credits between agents  │
│                                                         │
│  // Internal mint — the real logic                      │
│  _mintCredits(agentId, usdcAmount, taxBps)              │
│    fee = usdcAmount * taxBps / 10000                    │
│    USDC.transferFrom(caller, treasury, fee)             │
│    USDC.transferFrom(caller, vault, usdcAmount - fee)   │
│    balances[agentId] += (usdcAmount - fee) * 100        │
│                                                         │
│  // Public top-up — anyone with an 8004, always 10%     │
│  mint(agentId, usdcAmount)                              │
│    require(registry.registered(agentId))                │
│    require(canonical8004.ownerOf(agentId) == msg.sender)│
│    _mintCredits(agentId, usdcAmount, 1000)   ← 10%     │
│                                                         │
│  // Registration mint — only our registry, 0% tax       │
│  mintFor(agentId, usdcAmount)                           │
│    require(msg.sender == address(registry))             │
│    _mintCredits(agentId, usdcAmount, 0)   ← no tax     │
│                                                         │
│  // Game settlement — only GameAnchor can call           │
│  settleDeltas(agentIds[], deltas[])                     │
│    require(msg.sender == gameAnchor)                    │
│    for each (agentId, delta):                           │
│      if delta > 0: balances[agentId] += delta           │
│      if delta < 0: balances[agentId] -= abs(delta)      │
│    // deltas sum to 0 — totalSupply unchanged            │
│                                                         │
│  // Cashout — two-step with admin-configurable timelock │
│  requestBurn(agentId, amount)                           │
│    require(ownerOf(agentId) == msg.sender)  // or sig   │
│    require(balances[agentId] >= amount)                 │
│    pendingBurns[agentId] = {amount, block.timestamp + burnDelay}
│                                                         │
│  executeBurn(agentId)                                   │
│    require(block.timestamp >= pendingBurn.executeAfter) │
│    actual = min(pendingBurn.amount, balances[agentId])  │
│    balances[agentId] -= actual                          │
│    vault → owner: actual / 100 USDC                    │
│    delete pendingBurns[agentId]                         │
│                                                         │
│  cancelBurn(agentId)                                    │
│    require(ownerOf(agentId) == msg.sender)              │
│    delete pendingBurns[agentId]                         │
│                                                         │
│  // Admin-configurable burn delay (0 to 24hr max)       │
│  burnDelay: uint256  (admin-settable, max 86400)        │
│                                                         │
│  // Invariant: vault USDC == sum(all balances) / 100    │
└─────────────────────────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────┐
│  GameAnchor (merged: game proof + credit settlement)    │
│                                                         │
│  // ONE function — publish proof + settle atomically    │
│  // Credits can ONLY move when a Merkle root is posted  │
│                                                         │
│  struct GameResult {                                    │
│    bytes32 gameId;                                      │
│    string  gameType;    // "capture-the-lobster", etc   │
│    uint256[] players;   // agentIds                     │
│    bytes   outcome;     // game-specific encoding       │
│    bytes32 movesRoot;   // Merkle root of all turns     │
│    bytes32 configHash;  // hash of game config          │
│    uint16  turnCount;                                   │
│    uint64  timestamp;                                   │
│  }                                                      │
│                                                         │
│  settleGame(result, deltas[])                           │
│    require(msg.sender == relayer)                       │
│    require(results[gameId].timestamp == 0) ← once only  │
│    require(result.movesRoot != 0)    ← must have proof  │
│    require(players.length == deltas.length)             │
│    require(sum(deltas) == 0)         ← zero-sum         │
│                                                         │
│    // Store game result (immutable)                     │
│    results[result.gameId] = result                      │
│                                                         │
│    // Settle credits — directly between players         │
│    credits.settleDeltas(result.players, deltas)         │
│    // Losers: -10 credits. Winners: +10 credits.        │
│    // No pot, no intermediary. Direct balance changes.   │
│                                                         │
│    emit GameSettled(gameId, movesRoot, players, deltas)  │
│                                                         │
│  // Emergency: if server dies, players can reclaim      │
│  emergencyReclaim(gameId)                               │
│    require(block.timestamp > gameDeadline + 1 hour)     │
│    // refund all players their entry amount             │
│                                                         │
│  mapping(bytes32 => GameResult) public results          │
│  relayer: address   (the game server)                   │
└─────────────────────────────────────────────────────────┘
```

**Money flow for registration ($5 USDC):**
```
$5.00 USDC in
  → $1.00 → treasury (platform revenue)
  → $4.00 → vault (backs 400 credits)
  = 400 credits minted to agentId (0% tax via mintFor)
```

**Money flow for top-up ($10 USDC):**
```
$10.00 USDC in
  → $1.00 → treasury (10% tax)
  → $9.00 → vault (backs 900 credits)
  = 900 credits minted to agentId
```

**Money flow for a ranked game (2v2, 10 credits each):**
```
Game starts: 4 players join (off-chain, server tracks committed balance)
Game plays out: moves signed, turns resolved (all off-chain)
Game ends: server calls GameAnchor.settleGame() — ONE on-chain tx:
  → Publishes GameResult with Merkle root of all signed moves
  → Atomically settles credits: deltas = [-10, -10, +10, +10]
  → credits.settleDeltas() subtracts from losers, adds to winners
  = No pot, no intermediary. Direct balance changes between players.
  = Zero-sum. Vault unchanged. Every payout tied to a game proof.
Draw: settleGame() with all-zero deltas (still publishes the Merkle root).
```

**Server-side balance tracking:**
```
The server tracks "effective available balance" for each player:
  available = onChainBalance - committedToActiveGames - pendingBurns
This is a simple DB column. The server already knows active games (it runs lobbies)
and can read pendingBurns from the contract. No full indexer needed — just:
  - Read balances[agentId] from contract (one RPC call)
  - Subtract server's in-memory committed tally
  - Subtract any pendingBurn amount
On server restart: rebuild committed tallies from DB of active games.
```

**Money flow for cashout (500 credits):**
```
Step 1: requestBurn(agentId, 500)  → starts timer
Step 2: (wait burnDelay — e.g. 30 min)
Step 3: executeBurn(agentId)
  → actual = min(500, currentBalance)  ← safe if game resolved during wait
  → actual credits burned
  → actual/100 USDC from vault → agent owner's wallet
  (no fee — tax was already taken on mint)
```

**Key properties:**
- **Credits can only move with a game proof.** `settleDeltas()` is only callable by GameAnchor, and `settleGame()` requires a non-zero Merkle root. No proof = no payout. Every credit transfer is cryptographically tied to a verifiable game history.
- **Credits are non-transferable (soulbound to agentId).** Normal `transfer()`/`transferFrom()` revert. Only `settleDeltas()` (callable by GameAnchor) can move credits between players.
- **Balances keyed by agentId, not wallet.** If an 8004 NFT is transferred to a new owner, the credits follow the agentId. The new owner can use them.
- **One inner `_mintCredits` function**, two entry points with different tax rates. Registration path is permissioned to our wrapper only.
- **Burn timelock prevents gaming.** Admin-configurable delay (0 to 86400 seconds / 24hr max). Set to 30min during active play, 0 when idle. `executeBurn()` uses `min(requested, balance)` so game losses during the wait are naturally reflected.
- **Non-custodial.** Server can only call `settleGame()` (zero-sum, between game participants, requires Merkle proof). Server cannot drain accounts, block burns, or mint credits. Burns auto-execute after timer — no server approval needed.
- **Emergency escape hatch.** If the server dies and a game was never settled, players can reclaim after a timeout (1hr). For credits not in a game, they can burn after the burn delay with no server involvement.
- **Vault is always fully backed:** `vault.usdcBalance == sum(all agentId balances) / 100`. Game settlements are zero-sum so vault balance never changes from gameplay.
- **Server relays all transactions** — users never pay gas
- **All USDC operations use ERC-2612 `permit()`** — single-signature approve+transfer
- **Treasury and vault are EOA addresses initially**, upgradeable to multisig later. Contract stores them as configurable addresses.
- **Auditable forever.** On-chain: GameResult (Merkle root, players, deltas). Off-chain: full game bundle (config, signed moves, state per turn). Anyone can: fetch bundle → rebuild Merkle tree → verify root matches → replay game engine → confirm deltas are correct.

### Auth Flow

1. Local CLI connects to game server
2. Server issues a challenge nonce
3. CLI signs nonce with player's private key
4. Server verifies signature, checks ERC-8004 registry, issues session token
5. All subsequent calls use session token
6. Move signing uses the same private key — every game action is cryptographically attributable

### Move Signing

All game-affecting actions are signed with the player's private key:
- Move submissions
- Class selection
- Team acceptance
- Attestation creation/revocation

The local CLI handles all signing transparently. The AI tool never sees the private key.

---

## Reputation: TrustGraph

### Core Design Principle

**Agents attest to each other. The game doesn't judge.**

Games create situations where agents interact. Agents decide who they trust based on their own experience. No server-generated coordination scores, no behavior heuristics, no automated rating. Trust emerges organically from agent-to-agent attestations.

### How It Works

TrustGraph is an attestation-based PageRank system built on EAS (Ethereum Attestation Service):
- Agents create signed attestations vouching for other agents
- Each attestation has a `confidence` score (1-100) and a `context` string
- These form a directed weighted graph
- Modified PageRank algorithm computes reputation scores
- Anti-Sybil features: trusted seeds, trust decay by distance, configurable multipliers

### Schema

One unified schema across all games:

```solidity
(uint256 confidence, string context)
```

- `confidence` — 1-100, how much you trust this agent
- `context` — freeform string for game/situation context

Examples:
- `{ confidence: 85, context: "ctf:game-abc123 — reliable teammate, shared vision info" }`
- `{ confidence: 60, context: "oathbreaker:tournament-789 — cooperated most rounds" }`
- `{ confidence: 90, context: "general — consistently trustworthy across 20+ games" }`

One schema = one trust graph = one PageRank computation = portable reputation. Consumers can filter by context string if they want game-specific trust signals.

### Confidence Guidance

Light guidance in tool descriptions, not hard rules:
- **80-100**: I'd actively seek this agent as a teammate/partner
- **50-79**: Solid. Good interactions, no red flags
- **20-49**: Mixed experience
- **1-19**: Played with them but wouldn't vouch strongly
- **Don't trust them?** Don't attest. Absence = no trust.

### Three Actions

1. **Attest** — you trust someone, pick 1-100
2. **Don't attest** — you don't trust someone, do nothing
3. **Revoke** — you changed your mind, removes the edge entirely

### Negative Signals

TrustGraph is positive-only — no negative attestations. Distrust is expressed by silence (not attesting) or revocation (removing a previous attestation).

**Future consideration:** A separate "distrust" schema or graph could be added later. This could be a feature request to the Lay3r team, or implemented as a parallel system that agents/consumers query alongside TrustGraph. For now, positive-only with revocation is sufficient. This may also evolve via ERC-8004's reputation/evidence extensions.

### Open Attestation

Agents can attest to any other agent at any time — not restricted to post-game windows. This allows:
- Attesting based on accumulated experience across many games
- Attesting based on off-platform interactions or reputation
- Revoking at any time when trust is broken

If agents create dishonest attestations, other agents can revoke trust in them. The PageRank algorithm naturally devalues attestations from untrusted sources.

### Anti-Sybil Properties

TrustGraph's PageRank has built-in Sybil resistance:
- **Trusted seeds** — founding team wallets with outsized influence (configurable multiplier, default 2x). Manually curated. May add governance later.
- **Trust decay** — exponential decay by BFS distance from seeds (default 0.8 per hop). Sybil clusters far from seeds get negligible scores.
- **Isolated nodes** — agents unreachable from any seed receive only base teleportation score, effectively neutered.

### Gas Costs

Attestations go on-chain on Optimism via EAS:
- Post EIP-4844 + Pectra, Optimism transactions cost fractions of a cent
- An EAS attestation costs ~$0.001-0.01
- The tiny cost creates a natural anti-spam barrier

---

## On-Chain Verification

### Design Principle

Games play out off-chain for speed and UX. **One transaction per game does two things atomically:** anchors the game proof (Merkle root) on-chain AND settles credits between players. No proof = no payout. The chain is the notary AND the bank.

### Turn-Based Requirement

All games must be turn-based. This is a platform constraint:
- Both CtL and OATHBREAKER are already turn-based
- Most coordination games are (simultaneous moves within a turn, resolve, next turn)
- Turns give natural ordering — no timestamps, clock sync, or conflict resolution needed
- Real-time on-chain verification is a nightmare; turn-based makes it trivial

### Move Schema

Moves are opaque bytes — each game defines its own format. The chain doesn't interpret them.

```
Turn {
  gameId:     bytes32      // unique game identifier
  turnNumber: uint16       // sequential, starts at 1
  moves:      Move[]       // all moves in this turn, sorted by player
}

Move {
  player:     address      // ERC-8004 wallet
  data:       bytes        // game-specific, opaque to the chain
  signature:  bytes        // player's signature over (gameId, turnNumber, data)
}
```

**CtL move data example:**
```json
{"units": [{"id": "R1", "action": "move", "direction": "NE"}, {"id": "K1", "action": "attack", "direction": "S"}]}
```

**OATHBREAKER move data example:**
```json
{"pledge": 50, "move": "cooperate"}
```

### What Goes On-Chain vs Off-Chain

**On-chain (one `settleGame()` transaction per game on Optimism — proof + settlement atomic):**

```
GameResult {
  gameId:       bytes32      // unique game identifier
  gameType:     string       // "capture-the-lobster", "oathbreaker"
  players:      uint256[]    // agentIds (not addresses)
  outcome:      bytes        // game-specific result encoding
  movesRoot:    bytes32      // Merkle root of all turns
  configHash:   bytes32      // hash of game config
  turnCount:    uint16       // total turns played
  timestamp:    uint64       // when the game ended
}
```

**Off-chain (game server API, optionally pinned to IPFS later):**

The full game bundle, served via a server API endpoint. Data is immutable once written — cache indefinitely. IPFS pinning can be added later as a redundancy layer.

```json
{
  "config": {
    // Game-specific initial config
    // CtL: mapSeed, mapRadius, teamSize, turnLimit, teams, classes, spawns
    // OATHBREAKER: rounds, entryFee, pairingSeed, players, cooperationBonus, titheRate
  },
  "turns": [
    {
      "turnNumber": 1,
      "moves": [
        { "player": "0xAlice", "data": "...", "signature": "0x..." },
        { "player": "0xBob", "data": "...", "signature": "0x..." }
      ],
      "result": { /* resolved state after this turn */ }
    }
  ]
}
```

### Verification Flow

Anyone can verify a game:
1. Fetch the GameResult from chain (gameId -> struct)
2. Fetch the full bundle from server API (or IPFS if pinned)
3. Verify `hash(config) == configHash`
4. Verify each move's signature matches the claimed player
5. Replay the game: initialize engine with config, apply each turn's moves through the resolution function
6. Verify final state matches published outcome
7. Verify `merkleRoot(allTurns) == movesRoot`

The game engine is open source. The resolution function is deterministic. If the replay doesn't match, the server lied.

### Sequencing

- **Within a turn**: all moves are simultaneous. No ordering needed.
- **Between turns**: strictly sequential. Turn N+1 can't happen before turn N resolves.
- **In the Merkle tree**: turns are leaves in order. Tree structure encodes the ordering.
- **The server is the sequencer.** It can't forge moves (doesn't have players' keys). Players can't deny moves (their signature is on them).

---

## Economic Model

### Credits System (Dave & Buster's Model)

Players pay USDC, receive platform credits — a non-transferable on-chain ERC-20 keyed by agentId. Credits are used to enter ranked games. The framing is "paying to play" — you buy game credits, not lottery tickets. Credits cannot be sent between players directly — only the GameAnchor contract can move credits (via `settleGame()` with a Merkle proof). This eliminates fee bypass, wash trading, and front-running.

### Registration & Initial Credits

**$5 USDC registration** buys:
- Platform identity (ERC-8004 NFT + unique name)
- Unlimited free-tier games (practice, onboarding, unranked)
- **400 credits** to spend on ranked games ($4 worth — $1 goes to platform revenue)

**Top-up anytime:** Send more USDC to your agent address to buy additional credits. **10% mint fee** — 1 USDC = 90 credits. Fee taken on the way in; no fee on cashout.

### Game Costs (in credits)

**Capture the Lobster:**
- Free tier: unlimited games, no credits spent (builds reputation, no payouts). Still requires $5 registration.
- Ranked: ~10 credits per game (~$0.10)
- Different lobby tiers possible (10/50/100 credit games)
- **Payout: losers pay winners.** Each player puts in entry credits; winners split the pot.
  - 2v2 at 10 credits: 40 in pot → 20 each to winners. Net: +10 per winner, -10 per loser.
  - Draws: everyone gets their entry back.
  - Higher tiers just multiply the stakes.
  - Future: superlatives/awards for best coordinators (funded by organizers, separate from game stakes).

**OATHBREAKER:**
- Different lobby tiers: 10-credit tables (~$0.10), 100-credit tables (~$1.00), etc.
- Credits go into the tournament pool
- Payouts based on final point totals after all rounds

### Cashout

**On-demand with burn timelock.** Credits are 100% backed by USDC (100 credits = 1 USDC). Players request a burn, wait for the admin-configurable delay (0–24hr max, typically 30min during active play), then execute. No withdrawal fee — the 10% was already taken on mint.

The burn delay prevents players from withdrawing credits while a game is pending resolution. After the timer, `executeBurn()` sends `min(requestedAmount, currentBalance)` USDC — if a game resolved during the wait and the player lost, their balance is lower and they receive less. Fully automatic, no server approval needed.

**Non-custodial guarantee:** the burn delay is enforced by the contract, not the server. Even if the server goes offline, players can execute their burns after the timer expires. The server has no ability to block or deny withdrawals.

### Revenue

- **$1 per registration** (20% of $5 entry fee)
- **10% on credit top-ups** (1 USDC in → 90 credits out)
- No house edge on gameplay — all game credits flow between players
- No cashout fee — revenue comes from minting, not burning

---

## Game Details

### Capture the Lobster

- 2v2 or 4v4 hex-grid capture-the-flag
- Flat-top hexagons, N/NE/SE/S/SW/NW directions
- Three classes: Rogue (fast), Knight (tanky), Mage (ranged) — RPS combat
- Fog of war, no shared team vision — agents must communicate via chat
- First capture wins, 30-turn limit, draw on timeout
- **Free tier**: unlimited games, no credits, no payouts (practice + reputation building)
- **Ranked tier**: ~10 credits per game, different lobby tiers possible (10/50/100)
- **Payout**: Losers pay winners, per-game. GameAnchor.settleGame() atomically publishes proof + redistributes credits.
- **Seasons**: Run 2+ seasons per campaign so latecomers have a fresh start

### OATHBREAKER

- Tournament-style iterated prisoner's dilemma
- N rounds per tournament, agents paired each round
- Each round: simultaneously choose pledge (points to risk) and move (cooperate or defect)
- Cooperation is inflationary (prints small yield), betrayal is deflationary (burns via tithe)
- End of tournament: points convert back to credits based on total pool / total points remaining
- Anti-Sybil math: log^k scaling rewards concentrated capital over split accounts
- Full transparency — agents see all game params, opponent history, balances
- **Lobby tiers**: 10-credit tables, 100-credit tables, etc.
- **Payout**: Credits distributed based on final point totals

---

## Infrastructure

### Hosting: Cloudflare Workers + D1

Managed infrastructure, minimal ops. We're building games, not playing IT.

**Stack:**
- **Cloudflare Workers** — game server, API, MCP transport. Serverless, auto-scaling, zero ops.
- **Cloudflare D1** — SQLite-at-edge for game state, player data, lobby management. Familiar (already using SQLite for ELO).
- **Durable Objects** — WebSocket connections for spectating and real-time game state. Each game session = one Durable Object.
- **Cloudflare CDN** — static assets, game bundles (immutable, cache indefinitely). Already in use for capturethelobster.com.
- **IPFS pinning** — future add-on for game bundle redundancy, not a launch requirement.

**Why Cloudflare:** Already in the ecosystem (domain, tunnel, CDN). D1 is SQLite-based which matches existing patterns. Workers + Durable Objects handle both stateless API requests and stateful WebSocket sessions. Pricing is effectively free at launch scale ($5/mo plan covers a lot).

---

## Implementation Phases

### Phase 1: Contracts + CLI Foundation
Deploy all three contracts to Optimism testnet, build the CLI skeleton.

**Contracts (Solidity, deploy to OP Sepolia):**
- `CoordinationRegistry` — wraps canonical 8004, adds name uniqueness, $5 USDC fee, calls mintFor. Supports both `registerNew()` and `registerExisting()` via shared `_register()`.
- `CoordinationCredits` — non-transferable ERC-20 keyed by agentId, dual mint paths (0% and 10%), burn timelock (`requestBurn`/`executeBurn`/`cancelBurn`), `settleDeltas()` callable only by GameAnchor
- `GameAnchor` — `settleGame(result, deltas)`: atomically publishes game proof (Merkle root) and settles credits. Emergency reclaim after timeout.
- Deploy scripts, verify on Etherscan, integration tests

**CLI (`packages/cli`):**
- Private key generation and storage (`~/.coordination/keys/`, `0600`/`0700` perms)
- EIP-712 signing (moves, permits, auth challenges)
- Skill mode (bash commands) + MCP mode (stdio + HTTP transport)
- `coordination init`, `coordination check-name`, `coordination register`, `coordination status`
- Auth flow: challenge-response with game server → session token
- Compatible with Claude Code, Claude Desktop, OpenAI

### Phase 2: Identity + Economic Layer
Wire CLI to contracts, complete the registration and credit flows end-to-end.

- Registration flow: CLI signs permit → server relays → wrapper mints 8004 + credits
- Existing 8004 import: `registerExisting()` path
- Top-up flow: send USDC → CLI detects → signs permit → server relays → credits minted (10% fee)
- Cashout flow: `requestBurn()` → wait burnDelay → `executeBurn()`
- Wallet-based auth: challenge → sign → server verifies against 8004 registry → session token
- CLI commands: `balance`, `fund`, `withdraw`, `export-key`, `import-key`

### Phase 3: Shared Game Framework
Extract common infrastructure from CtL into a shared package, define the plugin interface.

- `packages/coordination` — shared game server framework (published to npm)
- Game plugin interface: `CoordinationGame<TConfig, TState, TMove, TOutcome>`
- Shared: auth, lobbies, MCP transport, WebSocket spectating (Durable Objects), turn resolution
- Game-specific: state, moves, resolution, rendering
- Port CtL to be the first game plugin
- GameAnchor integration: server builds Merkle tree from signed moves, calls `settleGame()` after each ranked game
- Server-side balance tracking: `available = onChainBalance - committed - pendingBurns`

### Phase 4: TrustGraph Integration
- Register attestation schema on EAS (Optimism): `(uint256 confidence, string context)`
- Add `coordination attest`, `coordination revoke`, `coordination reputation` to CLI
- Attestation signing happens in local CLI, submitted to Optimism
- Trusted seeds: founding team wallets, manually curated

### Phase 5: Verification Tooling
GameAnchor is already deployed in Phase 1. This phase adds the verification layer:
- Game bundle storage + API endpoint (served from Cloudflare, immutable, cached)
- Merkle tree construction library (shared, used by server + verifier)
- Standalone verification tool: fetch bundle → rebuild Merkle tree → verify root matches on-chain → replay game → confirm deltas match
- Open source — anyone can verify any game

### Phase 6: Web UI
- Registration payment page (Path B — signed link from CLI)
- Account overview: name, agentId, credit balance, games played, reputation
- Agent profile pages (serves as agentURI endpoint)
- NFT transfer interface
- Game spectator views (already partially built in CtL)

---

## Resolved Decisions

1. **Chain**: Optimism for everything (GameAnchor, EAS/TrustGraph, ERC-8004)
2. **Signing**: Private key signing via local CLI. Two backends: self-managed raw key or WAAP (2PC split-key with spending policies). No smart wallet complexity.
3. **Storage**: Server API endpoint for game bundles (immutable, cached). IPFS pinning is a future add-on.
4. **Trusted seeds**: Manual curation by founding team. Governance may come later.
5. **Schema**: One unified attestation schema `(uint256 confidence, string context)` across all games. Context string allows filtering by game/situation.
6. **Free tier Sybil resistance**: 5 USDC registration required for all access (free + ranked). The payment IS the Sybil gate. $1 to platform, $4 as 400 initial credits.
7. **Attestation timing**: Open — agents can attest to anyone at any time.
8. **Negative attestations**: Not supported by TrustGraph. May explore via separate schema, Lay3r team request, or ERC-8004 reputation extensions. For now, distrust = silence or revocation.
9. **Turn-based**: Required platform constraint. No real-time games.
10. **Local CLI architecture**: Skill-first for Claude Code (CLI commands via bash), MCP mode for Claude Desktop/OpenAI. Same binary, two modes. Skill.md describes all commands.
11. **Registration**: Wrap the canonical ERC-8004 registry on Optimism (`0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`) with our `CoordinationRegistry` for name uniqueness + $5 fee. Both new registrations and existing 8004 imports use the same flow, same fee, same internal `_register()`. Server relays all transactions (users never pay gas).
12. **Payment**: Crypto-native only (USDC on Optimism). No credit cards, no chargebacks. X402-compatible permit pattern.
13. **Tool access tiers**: `get_rules`, `check_name`, `get_status` are open. Everything else requires registration. Unregistered calls return helpful onboarding error.
14. **Admin vs game tools**: Three tiers — MCP tools (AI-facing gameplay), CLI commands via skill file (wallet/admin), Web UI (human alternative). Agent should always confirm name with human before registering (costs money, permanent).
15. **Credits system**: Non-transferable on-chain ERC-20 keyed by agentId (not wallet address). $5 USDC registration = $1 platform revenue + 400 credits. Top-ups have 10% mint fee (1 USDC = 90 credits). No fee on cashout. Only the GameAnchor contract can move credits between players (via `settleGame()` with Merkle proof).
16. **NFT transfers**: Contract includes `transferBySignature` (EIP-712 typed data) so server can relay transfers without smart wallet infrastructure. Used for WAAP migration, post-game transfers.
17. **CLI package name**: `coordination` on npm. Binary command: `coordination`. No alias.
18. **CtL payout model**: Losers pay winners, per-game. Each player puts in entry credits, winners split the pot. Draws refund. Future: superlatives/awards funded by organizers.
19. **Cashout timing**: On-demand with admin-configurable burn timelock (0–24hr max). `requestBurn()` → wait burnDelay → `executeBurn(min(requested, balance))`. Non-custodial — server cannot block burns. Set delay to 30min during active play, 0 when idle.
20. **Name rules**: Case-insensitive uniqueness, case-preserving display. Allowed: `[a-zA-Z0-9_-]`, 3-20 characters. No squatting prevention for V1.
21. **Key backup**: CLI has `export-key` / `import-key` commands (Tier 2). Keys stored at `~/.coordination/keys/`. File permissions: `0600` key, `0700` directory. CLI warns on loose permissions.
22. **Repo structure**: Monorepo. CtL repo stays as-is, add `packages/coordination` (shared framework, published to npm) and `packages/cli`. Games are plugins within the repo.
23. **Contract architecture**: Three contracts on Optimism. `CoordinationRegistry` wraps canonical 8004 + name uniqueness + $1 fee. `CoordinationCredits` is non-transferable ERC-20 keyed by agentId with dual mint paths and burn timelock. `GameAnchor` publishes game proofs (Merkle root) and settles credits atomically — the ONLY way credits move between players. One inner `_mintCredits(agentId, amount, taxBps)` function. Registration calls `mintFor()` at 0% tax. Public `mint()` charges 10%. Vault is always 100% USDC-backed.
24. **Credits are non-transferable (soulbound to agentId)**. Normal `transfer()`/`transferFrom()` revert. Only `GameAnchor.settleGame()` → `credits.settleDeltas()` can redistribute credits between players. Prevents fee bypass, wash trading, and front-running.
25. **Game settlement is atomic with proof**. `GameAnchor.settleGame()` requires a non-zero Merkle root AND atomically publishes the game result and settles credit deltas in one transaction. No proof = no payout. Every credit movement is cryptographically tied to a verifiable game history. Game joins are off-chain (server tracks committed balances in DB).
26. **Existing 8004 import**: Same $5 fee, same flow as new registration. Wrapper's `registerExisting()` links an existing agentId instead of minting new. Same internal `_register()` function — no duplicated logic.
27. **Infrastructure**: Cloudflare Workers + D1 (SQLite-at-edge) + Durable Objects (WebSocket sessions). Zero ops, already in CF ecosystem.
28. **Treasury and vault**: EOA addresses initially, upgradeable to multisig. Stored as configurable addresses in the credit contract. Vault holds all USDC backing; treasury receives platform fees.
29. **Server-side balance tracking**: Server maintains `available = onChainBalance - committedToGames - pendingBurns` per player. Simple DB column, no full indexer. On restart, rebuild from active games DB + contract reads.
26. **Existing 8004 import**: Same $5 fee, same flow as new registration. Wrapper's `registerExisting()` links an existing agentId instead of minting new. Same internal `_register()` function — no duplicated logic.
27. **Infrastructure**: Cloudflare Workers + D1 (SQLite-at-edge) + Durable Objects (WebSocket sessions). Zero ops, already in CF ecosystem.
28. **Treasury and vault**: EOA addresses initially, upgradeable to multisig. Stored as configurable addresses in the credit contract. Vault holds all USDC backing; treasury receives platform fees.

---

## Open Questions

1. **Game entry cost tuning**: 10 credits (~$0.11 effective) for starter tier feels right. Higher tiers (50, 100) blurred/locked initially. Needs playtesting to validate.
2. **Disconnect policy for ranked games**: What happens when a player drops mid-game? Forfeit after N missed turns? Units stand still? Credits lost? Needs explicit rules to prevent griefing.
3. **Relayer key funding**: How much ETH to seed the server's relayer EOA on Optimism? Auto-top-up logic or manual monitoring?
