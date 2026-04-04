# Plugin Architecture Refactor — Execution Plan

**Status:** Plan only — do not execute until Lucian reviews.
**Goal:** CtL becomes just a plugin (a few files). The platform is a generic game engine. Everything uses the plugin pipeline. End-to-end testable.

---

## Current State

### Codebase Structure
```
packages/
  engine/src/        — CtL game logic (hex, combat, fog, map, movement, game, lobby, plugin)
                       8 test files in __tests__/ (vitest)
  server/src/        — Express server, MCP (stdio + HTTP), bots, ELO, lobby runner
                       1 test file in __tests__/ (vitest)
  coordination/src/  — CoordinationGame interface, GameFramework, auth, balance, merkle
                       No tests
  contracts/         — Solidity contracts (hardhat, not anvil)
  cli/               — coordination CLI (exists, partially built)
  web/src/           — React frontend
```

### What Works Today
- CtL games run end-to-end: lobby → team formation → class selection → gameplay → spectating
- External agents connect via MCP HTTP at capturethelobster.com/mcp
- Claude bots play via Agent SDK
- ELO tracking with SQLite
- `CaptureTheLobsterPlugin` already implements `CoordinationGame` interface (engine/plugin.ts)
- `GameFramework` exists in coordination/ but is NOT used by the live server — the server still uses `GameManager` directly
- Live at capturethelobster.com via Cloudflare tunnel

### Key Problem
The server (api.ts, mcp-http.ts, lobby-runner.ts) directly uses `GameManager`, `LobbyManager`, and hardcoded chat/tools. The `CoordinationGame` interface and `GameFramework` exist but are unused bridges. The refactor makes the framework the actual runtime.

---

## Target State

### Package Structure
```
packages/
  platform/              — Generic game server framework
    src/
      types.ts           — All shared types (CoordinationGame, ToolPlugin, LobbyPhase, Message, etc.)
      framework.ts       — GameFramework (manages rooms, plugins, lobbies)
      lobby.ts           — LobbyRoom, phase pipeline runner
      plugin-loader.ts   — Plugin registry, topological sort, pipeline builder
      relay.ts           — Typed data relay for plugin communication
      mcp.ts             — Generic MCP transport, phase-aware tool visibility
      spectator.ts       — WebSocket spectator feed with configurable delay
      guide.ts           — Dynamic guide generator (game rules + active plugins + player state)
      auth.ts            — Wallet-based auth (from coordination/)
      balance.ts         — Vibes tracking (from coordination/)
      merkle.ts          — Merkle tree construction (from coordination/)
      phases/
        queue.ts         — Platform phase: collect players, timeout, ready-check
        shuffle.ts       — Platform phase: random sub-lobbies
        random-pairing.ts — Platform phase: pair opponents (for OATHBREAKER)
      __tests__/
        framework.test.ts
        lobby.test.ts
        plugin-loader.test.ts
        relay.test.ts
        guide.test.ts

  games/
    capture-the-lobster/
      src/
        plugin.ts        — CaptureTheLobsterPlugin (CoordinationGame impl + LobbyConfig)
        hex.ts           — Axial hex coordinates (unchanged)
        los.ts           — Line-of-sight (unchanged)
        combat.ts        — RPS combat resolution (unchanged)
        fog.ts           — Fog of war (unchanged)
        map.ts           — Procedural map generation (unchanged)
        movement.ts      — Movement validation & resolution (unchanged)
        game.ts          — GameManager (turn resolution, state — loses chat responsibility)
        phases/
          team-formation.ts  — LobbyPhase: team proposals, acceptance, auto-merge
          class-selection.ts — LobbyPhase: pick rogue/knight/mage
        __tests__/
          (existing 8 test files, moved here)
          team-formation.test.ts
          class-selection.test.ts

  plugins/
    basic-chat/
      src/
        index.ts         — Chat plugin (ToolPlugin impl)
      __tests__/
        chat.test.ts
    elo/
      src/
        index.ts         — ELO tracker plugin (ToolPlugin impl)
      __tests__/
        elo.test.ts      — (existing, moved)

  server/src/            — Thin server entry point (wires platform + games + plugins)
    index.ts             — Creates GameFramework, registers games & plugins, starts HTTP
    bot-harness.ts       — Claude bot testing harness (not part of platform)
    __tests__/
      integration.test.ts — Full game lifecycle test

  cli/                   — coordination CLI (existing, needs updates)
  contracts/             — Solidity contracts (existing)
  web/src/               — React frontend (existing)
```

### What Changes vs What Stays
| Component | Action |
|---|---|
| `engine/hex.ts`, `los.ts`, `combat.ts`, `fog.ts`, `map.ts`, `movement.ts` | **Move** to `games/capture-the-lobster/` — unchanged code |
| `engine/game.ts` | **Move + modify** — remove chat, keep pure turn resolution |
| `engine/lobby.ts` | **Extract into** `games/capture-the-lobster/phases/` — two LobbyPhase impls |
| `engine/plugin.ts` | **Move + extend** — add LobbyConfig, requiredPlugins, recommendedPlugins |
| `coordination/types.ts` | **Move to** `platform/types.ts` — add ToolPlugin, LobbyPhase, Message types |
| `coordination/server/framework.ts` | **Move to** `platform/framework.ts` — add lobby pipeline, plugin loader |
| `coordination/merkle.ts`, `auth.ts`, `balance.ts` | **Move to** `platform/` — unchanged |
| `server/api.ts` | **Rewrite** — thin wrapper calling GameFramework |
| `server/mcp-http.ts` | **Move to** `platform/mcp.ts` — genericize, phase-aware tools |
| `server/mcp.ts` (stdio) | **Delete** — replaced by CLI's MCP serve mode |
| `server/elo.ts` | **Move to** `plugins/elo/` — wrap as ToolPlugin |
| `server/claude-bot.ts`, `lobby-runner.ts` | **Move to** `server/bot-harness.ts` — testing only |
| `server/coordination.ts` | **Delete** — no longer needed, framework is the runtime |
| `server/relay.ts` | **Move to** `platform/relay.ts` — extend for plugin typed data |
| All existing engine tests | **Move to** `games/capture-the-lobster/__tests__/` |

---

## Execution Phases

### Phase 1: Types & Interfaces (non-breaking, additive)

**What:** Add all new types to `coordination/types.ts`. No code changes to runtime.

**Files to modify:**
- `packages/coordination/src/types.ts` — add:

```typescript
// ── ToolPlugin ──
interface ToolPlugin {
  id: string;
  version: string;
  modes: PluginMode[];
  purity: 'pure' | 'stateful';
  tools?: ToolDefinition[];
  init?(ctx: PluginContext): void;
  handleData(mode: string, inputs: Map<string, any>): Map<string, any>;
  handleCall?(tool: string, args: unknown, caller: AgentInfo): unknown;
}

interface PluginMode {
  name: string;
  consumes: string[];
  provides: string[];
}

interface PluginContext {
  gameType: string;
  gameId: string;
  turnCursor: number;
  relay: RelayClient;
  playerId: string;
}

interface AgentInfo {
  id: string;
  handle: string;
  team?: string;
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, any>;
}

// ── LobbyPhase ──
interface LobbyPhase<TPhaseState = any> {
  id: string;
  name: string;
  run(ctx: PhaseContext): Promise<PhaseResult>;
}

interface PhaseContext {
  players: AgentInfo[];
  gameConfig: Record<string, any>;
  relay: RelayAccess;
  onTimeout(): PhaseResult;
}

interface PhaseResult {
  groups: AgentInfo[][];
  metadata: Record<string, any>;
  removed?: AgentInfo[];
}

// ── LobbyConfig (replace existing simple version) ──
interface LobbyConfig {
  queueType: 'open' | 'stake-tiered' | 'invite';
  phases: LobbyPhaseConfig[];
  matchmaking: MatchmakingConfig;
}

interface LobbyPhaseConfig {
  phaseId: string;
  config: Record<string, any>;
}

interface MatchmakingConfig {
  minPlayers: number;
  maxPlayers: number;
  teamSize: number;
  numTeams: number;
  queueTimeoutMs: number;
}

// ── Message type ──
interface Message {
  from: number;
  body: string;
  turn: number;
  scope: 'team' | 'all';
  tags: Record<string, any>;
}

// ── Add to CoordinationGame ──
// lobby: LobbyConfig;
// requiredPlugins: string[];
// recommendedPlugins: string[];
```

- `packages/engine/src/plugin.ts` — add lobby config to CaptureTheLobsterPlugin

**Tests:**
- `packages/coordination/src/__tests__/types.test.ts` — type-level tests: verify interfaces compile, mock implementations satisfy them
- Existing engine tests must still pass: `cd packages/engine && npx vitest run`

**Verification:** `npm run build --workspaces` succeeds. All existing tests pass.

---

### Phase 2: Plugin Loader & Pipeline (new code, no runtime impact)

**What:** Build the plugin composition engine. This is new code alongside existing code.

**New files:**
- `packages/coordination/src/plugin-loader.ts`:

```typescript
class PluginLoader {
  private registry: Map<string, ToolPlugin> = new Map();

  register(plugin: ToolPlugin): void;
  getPlugin(id: string): ToolPlugin | undefined;
  listPlugins(): string[];

  /**
   * Build execution pipeline from active plugins.
   * 1. Producers first (no consumes)
   * 2. Topological sort on dependency graph
   * 3. Independent providers merge
   * 4. Cycles = error
   */
  buildPipeline(activePlugins: string[]): PluginPipeline;

  /** Get MCP tool definitions for active plugins */
  getTools(activePlugins: string[]): ToolDefinition[];
}

class PluginPipeline {
  private steps: { plugin: ToolPlugin; mode: PluginMode }[];

  /** Execute pipeline for a turn */
  execute(initialData: Map<string, any>): Map<string, any>;
}
```

**Tests:**
- `packages/coordination/src/__tests__/plugin-loader.test.ts`:
  - Register plugins, verify listing
  - Build pipeline with linear chain (producer → mapper → enricher → filter)
  - Build pipeline with parallel providers (merge)
  - Detect and reject cycles
  - Verify topological order
  - Pipeline execute() passes data through correctly
  - getTools() returns only active plugin tools

**Verification:** `cd packages/coordination && npx vitest run`

---

### Phase 3: Lobby Phase Pipeline (new code, alongside existing LobbyManager)

**What:** Build the phase pipeline runner. Existing LobbyManager continues to work.

**New files:**
- `packages/coordination/src/server/lobby-pipeline.ts`:

```typescript
class LobbyPipeline {
  private phases: LobbyPhase[];
  private currentIndex: number = 0;
  private phaseState: any = null;

  constructor(phases: LobbyPhase[]);

  /** Start the pipeline with initial players */
  start(players: AgentInfo[], config: Record<string, any>): Promise<void>;

  /** Handle a player action in the current phase */
  handleAction(playerId: string, action: string, data: any): Promise<void>;

  /** Get current phase info */
  getCurrentPhase(): { id: string; name: string; index: number; total: number };

  /** Check if pipeline is complete */
  isComplete(): boolean;

  /** Get final result (all phase metadata merged) */
  getResult(): { groups: AgentInfo[][]; metadata: Record<string, any> };
}
```

- `packages/games/capture-the-lobster/src/phases/team-formation.ts`:
  - Wraps existing `LobbyManager` team formation logic
  - Implements `LobbyPhase` interface
  - `run()` handles proposals, acceptance, auto-merge

- `packages/games/capture-the-lobster/src/phases/class-selection.ts`:
  - Wraps existing `LobbyManager` pre-game logic
  - `run()` handles class picks, timer, team chat

**Tests:**
- `packages/coordination/src/__tests__/lobby-pipeline.test.ts`:
  - Pipeline runs phases in order
  - Phase results pass to next phase
  - Timeout triggers onTimeout fallback
  - Pipeline reports completion correctly
- `packages/games/capture-the-lobster/src/__tests__/team-formation.test.ts`:
  - Propose/accept team flow
  - Auto-merge with remaining players
  - Timeout produces valid groups
- `packages/games/capture-the-lobster/src/__tests__/class-selection.test.ts`:
  - Choose class updates state
  - Timer countdown works
  - Default class assignment on timeout

**Verification:** All phase tests pass. Existing lobby tests still pass.

---

### Phase 4: Extract Chat to Plugin (parallel to existing)

**What:** Create basic-chat as a ToolPlugin. Existing chat continues to work.

**New files:**
- `packages/plugins/basic-chat/src/index.ts`:

```typescript
export const BasicChatPlugin: ToolPlugin = {
  id: 'basic-chat',
  version: '0.1.0',
  modes: [{ name: 'messaging', consumes: [], provides: ['messaging'] }],
  purity: 'stateful',
  tools: [{
    name: 'chat',
    description: 'Send a message to your team',
    inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
  }],
  handleData(mode, inputs) {
    // Return stored messages as Message[] with tags bag
    return new Map([['messaging', this.getMessages()]]);
  },
  handleCall(tool, args, caller) {
    // Route to team/all based on game phase
    // Store message with per-agent cursor tracking
  },
};
```

- Per-agent message cursor tracking (prevents duplicates — critical, currently in mcp-http.ts)
- Phase-aware routing (lobby=all, pre-game=team, game=team)

**Tests:**
- `packages/plugins/basic-chat/src/__tests__/chat.test.ts`:
  - Send message, receive on same team
  - Don't receive messages from other team during game
  - Message cursor prevents duplicates
  - Phase-aware routing (all during lobby, team during game)
  - Messages include correct turn number
  - Tags bag is extensible

**Verification:** Chat plugin tests pass independently.

---

### Phase 5: Extract ELO to Plugin

**What:** Wrap existing ELO tracker as a ToolPlugin.

**New files:**
- `packages/plugins/elo/src/index.ts` — wraps `EloTracker` class
  - Tools: `get_leaderboard`, `get_my_stats`
  - Hooks into game completion events

**Tests:**
- Move existing `server/__tests__/elo.test.ts` to `plugins/elo/__tests__/`
- Add: plugin interface compliance test

**Verification:** Existing ELO tests pass in new location.

---

### Phase 6: Platform MCP (genericize mcp-http.ts)

**What:** Extract generic MCP transport from the current 1010-line mcp-http.ts.

**Key changes:**
- Phase-aware tool visibility: tools appear/disappear based on current lobby/game phase
- Plugin tools injected dynamically from PluginLoader.getTools()
- `get_rules` → `get_guide` (dynamic, personalized)
- Remove admin tools (signin, leaderboard, stats) — those go to CLI
- Keep game loop tools: get_guide, get_state, submit_move, wait_for_update + active plugin tools

**New file:** `packages/platform/src/mcp.ts`

```typescript
function getAvailableTools(
  phase: string,
  activePlugins: ToolPlugin[],
  phaseTools: Map<string, ToolDefinition[]>
): ToolDefinition[] {
  const platform = phaseTools.get(phase) ?? [];
  const plugin = activePlugins.flatMap(p => p.tools ?? []);
  return [...platform, ...plugin];
}

const PHASE_TOOLS: Map<string, ToolDefinition[]> = {
  'team-formation': [propose_team, accept_team, leave_team],
  'class-selection': [choose_class],
  'in_progress': [get_state, submit_move, wait_for_update],
};
// get_guide is always available
```

**Tests:**
- `packages/platform/src/__tests__/mcp.test.ts`:
  - Correct tools for each phase
  - Plugin tools appear when active
  - Plugin tools disappear when not active
  - get_guide returns dynamic content based on game + plugins

**Verification:** MCP tests pass. Manual test with agent-browser: visit game, verify tools work.

---

### Phase 7: Package Restructure (the big move)

**What:** Move files to new package structure. One atomic PR.

**Steps:**
1. Create new package dirs: `packages/platform/`, `packages/games/capture-the-lobster/`, `packages/plugins/basic-chat/`, `packages/plugins/elo/`
2. Add `package.json` for each new package (name, version, main, types, scripts)
3. Update root `package.json` workspaces to include new packages
4. Move files per the table in "What Changes vs What Stays" above
5. Update ALL import paths (use find-and-replace across codebase)
6. Update tsconfig.json files and project references
7. Delete `packages/engine/`, `packages/coordination/` (now empty)
8. `npm install --include=dev` to rebuild node_modules links
9. `npm run build --workspaces` must succeed
10. `npm run test --workspaces --if-present` must pass

**Tests:**
- All existing tests pass in new locations
- Build succeeds for every package
- No broken imports (TypeScript compiler catches these)

**Verification:**
```bash
npm run build --workspaces
npm run test --workspaces --if-present
```

---

### Phase 8: Wire It All Together (the integration)

**What:** Make the server use `GameFramework` + plugin pipeline as the actual runtime. Delete the old direct-call paths.

**Changes to `packages/server/src/index.ts`:**
```typescript
import { GameFramework } from '@lobster/platform';
import { CaptureTheLobsterPlugin } from '@lobster/games-ctl';
import { BasicChatPlugin } from '@lobster/plugin-chat';
import { EloPlugin } from '@lobster/plugin-elo';
import { TeamFormationPhase, ClassSelectionPhase } from '@lobster/games-ctl/phases';

const framework = new GameFramework({ turnTimeoutMs: 30000 });
framework.registerGame(CaptureTheLobsterPlugin);
framework.registerPlugin(BasicChatPlugin);
framework.registerPlugin(EloPlugin);
framework.registerPhase('team-formation', TeamFormationPhase);
framework.registerPhase('class-selection', ClassSelectionPhase);

// Start server with framework
startServer(framework, { port: 5173 });
```

**Delete:**
- `server/coordination.ts` (bridge code, no longer needed)
- `server/mcp.ts` (stdio transport, replaced by CLI)
- Direct GameManager/LobbyManager usage in api.ts

**Tests — Integration:**
- `packages/server/src/__tests__/integration.test.ts`:

```typescript
describe('Full game lifecycle', () => {
  it('runs a complete CtL game through the framework', async () => {
    // 1. Create framework, register CtL plugin + chat plugin
    // 2. Create lobby
    // 3. Add 4 players
    // 4. Run team formation phase → 2 teams of 2
    // 5. Run class selection phase → all pick classes
    // 6. Game starts
    // 7. Submit moves for several turns
    // 8. Verify state updates, fog of war, chat messages
    // 9. Game ends (or timeout)
    // 10. Verify outcome, payouts computed correctly
    // 11. Verify Merkle tree built
  });

  it('chat plugin delivers team-scoped messages', async () => {
    // Verify team A can't see team B messages during gameplay
  });

  it('plugin pipeline processes data in correct order', async () => {
    // Register chat + mock enricher + mock filter
    // Verify pipeline executes in topological order
  });

  it('MCP tools change based on game phase', async () => {
    // Lobby phase: propose_team, accept_team visible
    // Game phase: submit_move, get_state visible
    // propose_team NOT visible during gameplay
  });
});
```

**Verification:**
```bash
npm run test --workspaces --if-present
# Then manual e2e:
PORT=5173 node packages/server/dist/index.js &
npx agent-browser open http://localhost:5173
npx agent-browser screenshot screenshots/integration-test.png
# Verify frontend loads, games page works, lobby browser works
```

---

### Phase 9: E2E Testing with Agent Browser

**What:** Automated end-to-end tests that verify the full stack.

**New file:** `packages/server/src/__tests__/e2e.test.ts`

```typescript
import { execSync } from 'child_process';

describe('E2E: Full stack', () => {
  let serverProcess: ChildProcess;

  beforeAll(async () => {
    // Build everything
    execSync('npm run build --workspaces');
    // Start server
    serverProcess = spawn('node', ['packages/server/dist/index.js'], {
      env: { ...process.env, PORT: '5174', USE_CLAUDE_BOTS: 'false' },
    });
    await waitForServer('http://localhost:5174');
  });

  afterAll(() => serverProcess.kill());

  it('homepage loads', async () => {
    const res = await fetch('http://localhost:5174');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Capture the Lobster');
  });

  it('/games microsite loads', async () => {
    const res = await fetch('http://localhost:5174/games');
    expect(res.status).toBe(200);
  });

  it('MCP endpoint responds', async () => {
    const res = await fetch('http://localhost:5174/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
    });
    expect(res.status).toBe(200);
  });

  it('lobby API works', async () => {
    const res = await fetch('http://localhost:5174/api/lobbies');
    expect(res.status).toBe(200);
  });

  it('agent-browser can screenshot game page', async () => {
    execSync('npx agent-browser set viewport 900 900');
    execSync('npx agent-browser open http://localhost:5174');
    execSync('npx agent-browser screenshot /tmp/e2e-home.png');
    // Verify screenshot file exists and is non-empty
    const stat = fs.statSync('/tmp/e2e-home.png');
    expect(stat.size).toBeGreaterThan(1000);
  });
});
```

---

### Phase 10: Update Documentation

**What:** Update all docs to reflect new architecture.

- **CLAUDE.md** — Update package structure, build commands, file map
- **DESIGN.md** — Archive or merge into GAME_ENGINE_PLAN.md (it's stale)
- **TECHNICAL-SPEC.md** — Archive or merge (stale, describes monolithic architecture)
- **PLAYER-INTEGRATION.md** — Archive or merge (stale, describes old MCP-only flow)
- **README.md** — Update with new package structure, plugin system
- **GAME_ENGINE_PLAN.md** — Mark resolved decisions, update "Current codebase → new structure" section

---

## Test Strategy Summary

| Level | Tool | What's Tested |
|---|---|---|
| **Unit** | vitest | Hex math, combat, fog, movement, map gen, plugin loader, pipeline, phases |
| **Integration** | vitest | Full game lifecycle through framework, plugin pipeline ordering, phase transitions, MCP tool visibility |
| **E2E** | vitest + agent-browser | Server starts, pages load, MCP responds, API works, screenshots render |
| **Contract** | hardhat | CoordinationRegistry, Vibes, GameAnchor (existing) |

### Test Commands
```bash
# All tests
npm run test --workspaces --if-present

# Specific packages
cd packages/platform && npx vitest run
cd packages/games/capture-the-lobster && npx vitest run
cd packages/plugins/basic-chat && npx vitest run
cd packages/server && npx vitest run

# E2E only
cd packages/server && npx vitest run --testPathPattern e2e
```

---

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Breaking the live site | Do Phase 7 (restructure) in one atomic commit. Build + test before push. |
| LobbyManager coupling | Extract-and-wrap: LobbyPhase implementations call LobbyManager methods internally |
| Chat cursor deduplication | basic-chat plugin must replicate per-agent cursor logic from mcp-http.ts |
| npm workspace issues | Always `npm install --include=dev`. Test with clean node_modules. |
| Import path breakage | TypeScript compiler catches all broken imports at build time |
| Bot harness depends on old APIs | Keep as `server/bot-harness.ts`, update to use framework |

---

## Stale Documents

These docs describe the pre-plugin architecture and should be archived/replaced:

| Document | Status | Action |
|---|---|---|
| `DESIGN.md` | Stale — describes pre-plugin CtL design ("teams of 4" only) | Archive or delete; GAME_ENGINE_PLAN.md is the source of truth |
| `TECHNICAL-SPEC.md` | Stale — describes monolithic server architecture | Archive or delete; replaced by this plan + GAME_ENGINE_PLAN.md |
| `PLAYER-INTEGRATION.md` | Stale — describes old MCP-only flow, no CLI | Archive or delete; CLI flow is in GAME_ENGINE_PLAN.md |

---

## Handoff Prompt

Use this prompt when starting a fresh context to execute this refactor:

```
Read these files in order to understand the project and what needs to happen:

1. CLAUDE.md — Current codebase conventions, build commands, known issues
2. GAME_ENGINE_PLAN.md — The full platform vision: plugin architecture, Vibes economy, CoordinationGame interface, ToolPlugin interface, LobbyPhase pipeline, CLI/MCP split, on-chain layer
3. REFACTOR_PLAN.md — The concrete execution plan with 10 phases, test strategy, file-by-file migration map

Then execute REFACTOR_PLAN.md phases 1-10 in order. Each phase has:
- Exactly what files to create/modify/move
- What tests to write
- How to verify the phase is complete

Key constraints:
- The live site (capturethelobster.com) must keep working — don't break main
- Use vitest for all tests (already configured in the repo)
- Build with tsc --skipLibCheck (see CLAUDE.md for why)
- npm install --include=dev (see CLAUDE.md for the workspaces bug)
- The CtL game logic (hex, combat, fog, movement, map) is PROVEN CODE — move it, don't rewrite it
- Use agent-browser for visual verification (installed, Chrome available)
- Test each phase before moving to the next

The end state: CtL is just a plugin with a few files. The game engine is generic. Everything uses the plugin pipeline. All tests pass.
```
