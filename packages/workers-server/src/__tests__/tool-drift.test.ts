/**
 * Tool-surface drift invariants — release-blocking.
 *
 * These tests are the *reason* the unified-tool-surface refactor exists. They
 * catch any drift between the declared `ToolDefinition.inputSchema` and the
 * real validator (game `validateAction` for gameTools; phase `handleAction`
 * for LobbyPhase tools). See `docs/plans/unified-tool-surface.md` — "Testing
 * — drift invariants".
 *
 * Four invariants:
 *  1. Declared shape is accepted by the validator (no shape-mismatch false
 *     negatives). AJV validates the sample; the real validator returns ok or
 *     a *semantic* rejection (never a shape-mismatch rejection).
 *  2. Undeclared shape is rejected by AJV (required, additionalProperties, type).
 *  3. System-action isolation: every system action rejects non-null playerId;
 *     every gameTool rejects null playerId.
 *  4. Collision detection (lives in tool-collision.test.ts — server + client).
 *
 * Iteration is AUTOMATIC: we read `game.gameTools`, `game.lobby.phases[*].tools`,
 * and `plugin.tools` from the real registry. If a new tool is added without a
 * fixture entry in DRIFT_FIXTURES below, the test fails loudly with a pointer
 * to this file. New tools MUST come with a drift fixture.
 */

import type {
  AgentInfo,
  CoordinationGame,
  LobbyPhase,
  ToolDefinition,
  ToolPlugin,
} from '@coordination-games/engine';
import {
  CaptureTheLobsterPlugin,
  CTL_GAME_ID,
  CTL_SYSTEM_ACTION_TYPES,
} from '@coordination-games/game-ctl';
import {
  OATH_GAME_ID,
  OATHBREAKER_SYSTEM_ACTION_TYPES,
  OathbreakerPlugin,
} from '@coordination-games/game-oathbreaker';
import { BasicChatPlugin } from '@coordination-games/plugin-chat';
import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// AJV — strict instance. `additionalProperties: false` on tool schemas gives
// us the "undeclared shape rejected" invariant for free.
// ---------------------------------------------------------------------------

// biome-ignore lint/suspicious/noExplicitAny: drift tests reach into both CtL + OATHBREAKER state shapes via a generic harness; the alternative is duplicating each plugin's internal state types in this file.
const AjvCtor: typeof Ajv = (Ajv as any).default ?? Ajv;
const ajv = new AjvCtor({ allErrors: true, strict: false });

// ---------------------------------------------------------------------------
// Registered games + plugins under test
// ---------------------------------------------------------------------------

// biome-ignore lint/suspicious/noExplicitAny: drift tests reach into both CtL + OATHBREAKER state shapes via a generic harness; the alternative is duplicating each plugin's internal state types in this file.
const GAMES: CoordinationGame<any, any, any, any>[] = [CaptureTheLobsterPlugin, OathbreakerPlugin];

const PLUGINS: ToolPlugin[] = [BasicChatPlugin];

const SYSTEM_ACTIONS: Record<string, readonly string[]> = {
  [CTL_GAME_ID]: CTL_SYSTEM_ACTION_TYPES,
  [OATH_GAME_ID]: OATHBREAKER_SYSTEM_ACTION_TYPES,
};

// ---------------------------------------------------------------------------
// State-builder helpers per game. Each returns both the state and a concrete
// `playerId` that can be passed to the validator to exercise the "valid
// playerId" side of the invariant.
// ---------------------------------------------------------------------------

const CTL_PLAYERS: { id: string; handle: string }[] = [
  { id: 'p1', handle: 'alice' },
  { id: 'p2', handle: 'bob' },
  { id: 'p3', handle: 'carol' },
  { id: 'p4', handle: 'dave' },
];

/** Build a CtL in-progress state with 4 players split 2v2, rogues on both teams. */
// biome-ignore lint/suspicious/noExplicitAny: drift tests reach into both CtL + OATHBREAKER state shapes via a generic harness; the alternative is duplicating each plugin's internal state types in this file.
function buildCtlInProgressState(): { state: any; playerId: string } {
  const setup = CaptureTheLobsterPlugin.createConfig?.(
    CTL_PLAYERS.map((p) => ({ id: p.id, handle: p.handle })),
    'drift-test-seed',
    { teamSize: 2 },
  );
  // @ts-expect-error TS18048: 'setup' is possibly 'undefined'. — TODO(2.3-followup)
  // biome-ignore lint/suspicious/noExplicitAny: drift tests reach into both CtL + OATHBREAKER state shapes via a generic harness; the alternative is duplicating each plugin's internal state types in this file.
  let state: any = CaptureTheLobsterPlugin.createInitialState(setup.config);
  // Force into in_progress for the move validator to accept.
  state = { ...state, phase: 'in_progress' };
  // Pick an alive unit owner.
  // biome-ignore lint/suspicious/noExplicitAny: drift tests reach into both CtL + OATHBREAKER state shapes via a generic harness; the alternative is duplicating each plugin's internal state types in this file.
  const firstUnit = state.units.find((u: any) => u.alive);
  if (!firstUnit) throw new Error('drift fixture: no alive unit in fresh CtL state');
  return { state, playerId: firstUnit.id };
}

/** Build a CtL pre_game state (for system-action-isolation tests). */
// biome-ignore lint/suspicious/noExplicitAny: drift tests reach into both CtL + OATHBREAKER state shapes via a generic harness; the alternative is duplicating each plugin's internal state types in this file.
function buildCtlPreGameState(): any {
  const setup = CaptureTheLobsterPlugin.createConfig?.(
    CTL_PLAYERS.map((p) => ({ id: p.id, handle: p.handle })),
    'drift-test-seed',
    { teamSize: 2 },
  );
  // @ts-expect-error TS18048: 'setup' is possibly 'undefined'. — TODO(2.3-followup)
  return CaptureTheLobsterPlugin.createInitialState(setup.config);
}

const OATH_PLAYERS: { id: string; handle: string }[] = [
  { id: 'op1', handle: 'alice' },
  { id: 'op2', handle: 'bob' },
  { id: 'op3', handle: 'carol' },
  { id: 'op4', handle: 'dave' },
];

/** Build an OATH state with the round already started and pairings in 'pledging'. */
// biome-ignore lint/suspicious/noExplicitAny: drift tests reach into both CtL + OATHBREAKER state shapes via a generic harness; the alternative is duplicating each plugin's internal state types in this file.
function buildOathPledgingState(): { state: any; playerId: string } {
  const setup = OathbreakerPlugin.createConfig?.(
    OATH_PLAYERS.map((p) => ({ id: p.id, handle: p.handle })),
    'drift-test-seed',
  );
  const initial = OathbreakerPlugin.createInitialState(setup.config);
  // game_start transitions from 'waiting' → 'playing' with pairings set.
  const result = OathbreakerPlugin.applyAction(initial, null, { type: 'game_start' });
  const playerId = result.state.pairings[0]?.player1;
  if (!playerId) throw new Error('drift fixture: oath game_start produced no pairing');
  return { state: result.state, playerId };
}

/** Build an OATH state with a pairing in 'deciding' (both proposals matched). */
// biome-ignore lint/suspicious/noExplicitAny: drift tests reach into both CtL + OATHBREAKER state shapes via a generic harness; the alternative is duplicating each plugin's internal state types in this file.
function buildOathDecidingState(): { state: any; playerId: string } {
  const pledging = buildOathPledgingState();
  const pairing = pledging.state.pairings[0];
  const pledgeAmount = 10; // >= minPledge (5) and <= 50% of min balance (50)
  // Both players propose the same amount → transitions to 'deciding'.
  const after1 = OathbreakerPlugin.applyAction(pledging.state, pairing.player1, {
    type: 'propose_pledge',
    amount: pledgeAmount,
  });
  const after2 = OathbreakerPlugin.applyAction(after1.state, pairing.player2, {
    type: 'propose_pledge',
    amount: pledgeAmount,
  });
  const updatedPairing = after2.state.pairings[0];
  // @ts-expect-error TS18048: 'updatedPairing' is possibly 'undefined'. — TODO(2.3-followup)
  if (updatedPairing.phase !== 'deciding') {
    // @ts-expect-error TS18048: 'updatedPairing' is possibly 'undefined'. — TODO(2.3-followup)
    throw new Error(`drift fixture: oath pairing should be deciding, got ${updatedPairing.phase}`);
  }
  // @ts-expect-error TS18048: 'updatedPairing' is possibly 'undefined'. — TODO(2.3-followup)
  return { state: after2.state, playerId: updatedPairing.player1 };
}

/** Build an OATH 'waiting' state (for system-action-isolation tests). */
// biome-ignore lint/suspicious/noExplicitAny: drift tests reach into both CtL + OATHBREAKER state shapes via a generic harness; the alternative is duplicating each plugin's internal state types in this file.
function buildOathWaitingState(): any {
  const setup = OathbreakerPlugin.createConfig?.(
    OATH_PLAYERS.map((p) => ({ id: p.id, handle: p.handle })),
    'drift-test-seed',
  );
  return OathbreakerPlugin.createInitialState(setup.config);
}

// ---------------------------------------------------------------------------
// Lobby-phase state helpers (CtL only — OATH lobby phase has no tools)
// ---------------------------------------------------------------------------

const CTL_AGENTS: AgentInfo[] = CTL_PLAYERS.map((p) => ({ id: p.id, handle: p.handle }));

function findCtlPhase(id: string): LobbyPhase {
  const phase = CaptureTheLobsterPlugin.lobby?.phases.find((p) => p.id === id);
  if (!phase) throw new Error(`drift fixture: CtL phase "${id}" not found`);
  return phase;
}

// ---------------------------------------------------------------------------
// DRIFT_FIXTURES
//
// Per-tool test fixture: the valid sample args, a state builder, and a
// semantic-rejection predicate. The iteration below requires every
// discovered tool to have an entry keyed by "<source>:<name>".
// ---------------------------------------------------------------------------

type GameToolFixture = {
  /** Valid sample args (must match the tool's inputSchema). */
  // biome-ignore lint/suspicious/noExplicitAny: drift tests reach into both CtL + OATHBREAKER state shapes via a generic harness; the alternative is duplicating each plugin's internal state types in this file.
  validSample: Record<string, any>;
  /** Build a state where the valid sample is semantically accepted. */
  // biome-ignore lint/suspicious/noExplicitAny: drift tests reach into both CtL + OATHBREAKER state shapes via a generic harness; the alternative is duplicating each plugin's internal state types in this file.
  buildState: () => { state: any; playerId: string };
  /** The CoordinationGame owning this tool (for validateAction). */
  // biome-ignore lint/suspicious/noExplicitAny: drift tests reach into both CtL + OATHBREAKER state shapes via a generic harness; the alternative is duplicating each plugin's internal state types in this file.
  game: CoordinationGame<any, any, any, any>;
};

type LobbyToolFixture = {
  // biome-ignore lint/suspicious/noExplicitAny: drift tests reach into both CtL + OATHBREAKER state shapes via a generic harness; the alternative is duplicating each plugin's internal state types in this file.
  validSample: Record<string, any>;
  /** Build phase state + the player that can invoke this tool. */
  // biome-ignore lint/suspicious/noExplicitAny: drift tests reach into both CtL + OATHBREAKER state shapes via a generic harness; the alternative is duplicating each plugin's internal state types in this file.
  buildState: () => { state: any; playerId: string; players: AgentInfo[] };
  phase: LobbyPhase;
};

type PluginToolFixture = {
  // biome-ignore lint/suspicious/noExplicitAny: drift tests reach into both CtL + OATHBREAKER state shapes via a generic harness; the alternative is duplicating each plugin's internal state types in this file.
  validSample: Record<string, any>;
  plugin: ToolPlugin;
};

type Fixture =
  | { kind: 'game'; fixture: GameToolFixture }
  | { kind: 'lobby'; fixture: LobbyToolFixture }
  | { kind: 'plugin'; fixture: PluginToolFixture };

const DRIFT_FIXTURES: Record<string, Fixture> = {
  // -----------------------------------------------------------------
  // CtL game tool
  // -----------------------------------------------------------------
  'capture-the-lobster.game:move': {
    kind: 'game',
    fixture: {
      validSample: { path: ['N'] },
      buildState: () => buildCtlInProgressState(),
      game: CaptureTheLobsterPlugin,
    },
  },

  // -----------------------------------------------------------------
  // CtL lobby tools
  // -----------------------------------------------------------------
  'capture-the-lobster.lobby.team-formation:propose_team': {
    kind: 'lobby',
    fixture: {
      validSample: { targetHandle: 'bob' },
      buildState: () => {
        const phase = findCtlPhase('team-formation');
        const state = phase.init(CTL_AGENTS, {});
        return { state, playerId: 'p1', players: CTL_AGENTS };
      },
      phase: findCtlPhase('team-formation'),
    },
  },

  'capture-the-lobster.lobby.team-formation:accept_team': {
    kind: 'lobby',
    fixture: {
      // Propose first so an invite exists to accept.
      validSample: { teamId: 'team_1' },
      buildState: () => {
        const phase = findCtlPhase('team-formation');
        let state = phase.init(CTL_AGENTS, {});
        // p1 invites p2 → creates team_1 with p1 in members, p2 in invites.
        const proposeResult = phase.handleAction(
          state,
          { type: 'propose_team', playerId: 'p1', payload: { targetHandle: 'bob' } },
          CTL_AGENTS,
        );
        state = proposeResult.state;
        return { state, playerId: 'p2', players: CTL_AGENTS };
      },
      phase: findCtlPhase('team-formation'),
    },
  },

  'capture-the-lobster.lobby.team-formation:leave_team': {
    kind: 'lobby',
    fixture: {
      validSample: {},
      buildState: () => {
        const phase = findCtlPhase('team-formation');
        let state = phase.init(CTL_AGENTS, {});
        // p1 creates team_1 by proposing to p2 → p1 is now on a team.
        const proposeResult = phase.handleAction(
          state,
          { type: 'propose_team', playerId: 'p1', payload: { targetHandle: 'bob' } },
          CTL_AGENTS,
        );
        state = proposeResult.state;
        return { state, playerId: 'p1', players: CTL_AGENTS };
      },
      phase: findCtlPhase('team-formation'),
    },
  },

  'capture-the-lobster.lobby.class-selection:choose_class': {
    kind: 'lobby',
    fixture: {
      validSample: { unitClass: 'rogue' },
      buildState: () => {
        const phase = findCtlPhase('class-selection');
        const state = phase.init(CTL_AGENTS, {});
        return { state, playerId: 'p1', players: CTL_AGENTS };
      },
      phase: findCtlPhase('class-selection'),
    },
  },

  // -----------------------------------------------------------------
  // OATHBREAKER game tools
  // -----------------------------------------------------------------
  'oathbreaker.game:propose_pledge': {
    kind: 'game',
    fixture: {
      validSample: { amount: 10 },
      buildState: () => buildOathPledgingState(),
      game: OathbreakerPlugin,
    },
  },

  'oathbreaker.game:submit_decision': {
    kind: 'game',
    fixture: {
      validSample: { decision: 'C' },
      buildState: () => buildOathDecidingState(),
      game: OathbreakerPlugin,
    },
  },

  // -----------------------------------------------------------------
  // Plugin tools — no server-side validator (invariant 1 does not apply).
  // Still fixture'd for invariant 2 (AJV shape-rejection).
  // -----------------------------------------------------------------
  'plugin:basic-chat:chat': {
    kind: 'plugin',
    fixture: {
      validSample: { message: 'hello', scope: 'all' },
      plugin: BasicChatPlugin,
    },
  },
};

// ---------------------------------------------------------------------------
// Surface discovery — iterate the real registry, not a hardcoded list
// ---------------------------------------------------------------------------

interface DiscoveredTool {
  key: string; // matches DRIFT_FIXTURES key
  name: string;
  tool: ToolDefinition;
  source: // biome-ignore lint/suspicious/noExplicitAny: drift tests reach into both CtL + OATHBREAKER state shapes via a generic harness; the alternative is duplicating each plugin's internal state types in this file.
    | { kind: 'game'; game: CoordinationGame<any, any, any, any> }
    // biome-ignore lint/suspicious/noExplicitAny: drift tests reach into both CtL + OATHBREAKER state shapes via a generic harness; the alternative is duplicating each plugin's internal state types in this file.
    | { kind: 'lobby'; game: CoordinationGame<any, any, any, any>; phase: LobbyPhase }
    | { kind: 'plugin'; plugin: ToolPlugin };
}

function discoverTools(): DiscoveredTool[] {
  const out: DiscoveredTool[] = [];
  for (const game of GAMES) {
    for (const tool of game.gameTools ?? []) {
      out.push({
        key: `${game.gameType}.game:${tool.name}`,
        name: tool.name,
        tool,
        source: { kind: 'game', game },
      });
    }
    for (const phase of game.lobby?.phases ?? []) {
      for (const tool of phase.tools ?? []) {
        out.push({
          key: `${game.gameType}.lobby.${phase.id}:${tool.name}`,
          name: tool.name,
          tool,
          source: { kind: 'lobby', game, phase },
        });
      }
    }
  }
  for (const plugin of PLUGINS) {
    for (const tool of plugin.tools ?? []) {
      out.push({
        key: `plugin:${plugin.id}:${tool.name}`,
        name: tool.name,
        tool,
        source: { kind: 'plugin', plugin },
      });
    }
  }
  return out;
}

const DISCOVERED = discoverTools();

// ---------------------------------------------------------------------------
// Meta test — fixture coverage
// ---------------------------------------------------------------------------

describe('Tool drift — fixture coverage', () => {
  it('every discovered tool has a DRIFT_FIXTURES entry', () => {
    const missing = DISCOVERED.filter((d) => !DRIFT_FIXTURES[d.key]).map((d) => d.key);
    if (missing.length > 0) {
      throw new Error(
        `\nDRIFT_FIXTURES is missing entries for:\n  - ${missing.join('\n  - ')}\n\n` +
          `Every tool in gameTools ∪ LobbyPhase.tools ∪ plugin.tools MUST have a ` +
          `drift fixture. Add entries in packages/workers-server/src/__tests__/tool-drift.test.ts\n`,
      );
    }
  });

  it('every DRIFT_FIXTURES key matches a discovered tool (no dead entries)', () => {
    const discoveredKeys = new Set(DISCOVERED.map((d) => d.key));
    const dead = Object.keys(DRIFT_FIXTURES).filter((k) => !discoveredKeys.has(k));
    expect(dead, `Dead DRIFT_FIXTURES entries (no matching tool): ${dead.join(', ')}`).toEqual([]);
  });

  it('discovered surface matches the expected 8-tool count', () => {
    // If this breaks, either a tool was added (update the constant + fixtures)
    // or the existing surface shrank. Either change the constant intentionally.
    expect(DISCOVERED).toHaveLength(8);
  });
});

// ---------------------------------------------------------------------------
// Invariant 1 — Declared shape is accepted by the validator
// ---------------------------------------------------------------------------

describe('Invariant 1 — declared shape is accepted', () => {
  for (const d of DISCOVERED) {
    const entry = DRIFT_FIXTURES[d.key];
    if (!entry) continue; // covered by the fixture-coverage test above

    it(`${d.key}: AJV validates the sample shape`, () => {
      const validate = ajv.compile(d.tool.inputSchema);
      const ok = validate(entry.fixture.validSample);
      expect(
        ok,
        `AJV rejected the declared-valid sample for ${d.key}: ${JSON.stringify(validate.errors)}`,
      ).toBe(true);
    });

    if (entry.kind === 'game') {
      const f = entry.fixture as GameToolFixture;
      it(`${d.key}: validateAction accepts the sample (no shape-mismatch rejection)`, () => {
        const { state, playerId } = f.buildState();
        const action = { type: d.name, ...f.validSample };
        // biome-ignore lint/suspicious/noExplicitAny: drift tests reach into both CtL + OATHBREAKER state shapes via a generic harness; the alternative is duplicating each plugin's internal state types in this file.
        const accepted = f.game.validateAction(state, playerId, action as any);
        // The validator should return true (accepted). A false here would
        // indicate shape drift — the declaration says valid, the validator
        // says no. False is allowed ONLY if you can prove the rejection is
        // semantic (e.g. not-your-turn). In our fixtures, every state is
        // engineered so the sample is semantically accepted, so false =
        // drift.
        expect(
          accepted,
          `${d.key}: schema says "${JSON.stringify(f.validSample)}" is valid, but ` +
            `validateAction returned false. This is schema/validator drift — fix the ` +
            `inputSchema or the validator.`,
        ).toBe(true);
      });
    }

    if (entry.kind === 'lobby') {
      const f = entry.fixture as LobbyToolFixture;
      it(`${d.key}: phase.handleAction accepts the sample (no shape-mismatch rejection)`, () => {
        const { state, playerId, players } = f.buildState();
        const result = f.phase.handleAction(
          state,
          { type: d.name, playerId, payload: f.validSample },
          players,
        );
        // If the phase surfaced an `error`, it must NOT be a shape-mismatch.
        // Phases return `error.message` strings — check for telltale shape-
        // mismatch phrasings. Any true shape drift would surface here as a
        // "required", "is required", "Unknown action" type message.
        if (result.error) {
          const msg = result.error.message.toLowerCase();
          const shapeMismatchMarkers = [
            'is required',
            'unknown action type',
            'invalid_args',
            'missing property',
          ];
          const hit = shapeMismatchMarkers.find((m) => msg.includes(m));
          expect(
            hit,
            `${d.key}: phase.handleAction returned a shape-mismatch-looking error ` +
              `for a schema-valid sample: "${result.error.message}". ` +
              `This is schema/handler drift.`,
          ).toBeUndefined();
        }
      });
    }
    // Plugin tools: invariant 1 does not apply (no server-side validator).
  }
});

// ---------------------------------------------------------------------------
// Invariant 2 — Undeclared shape is rejected by AJV
// ---------------------------------------------------------------------------

describe('Invariant 2 — undeclared shape is rejected', () => {
  const REJECTION_KEYWORDS = new Set(['required', 'additionalProperties', 'type']);

  for (const d of DISCOVERED) {
    const entry = DRIFT_FIXTURES[d.key];
    if (!entry) continue;

    const validate = ajv.compile(d.tool.inputSchema);
    const sample = entry.fixture.validSample;
    // biome-ignore lint/suspicious/noExplicitAny: drift tests reach into both CtL + OATHBREAKER state shapes via a generic harness; the alternative is duplicating each plugin's internal state types in this file.
    const props = (d.tool.inputSchema.properties ?? {}) as Record<string, any>;
    const required: string[] = Array.isArray(d.tool.inputSchema.required)
      ? (d.tool.inputSchema.required as string[])
      : [];

    // -- missing required field --
    if (required.length > 0) {
      it(`${d.key}: AJV rejects missing required field "${required[0]}"`, () => {
        const broken = { ...sample };
        // @ts-expect-error TS2538: Type 'undefined' cannot be used as an index type. — TODO(2.3-followup)
        delete broken[required[0]];
        const ok = validate(broken);
        expect(ok).toBe(false);
        const keywords = new Set((validate.errors ?? []).map((e) => e.keyword));
        const hit = [...keywords].some((k) => REJECTION_KEYWORDS.has(k));
        expect(
          hit,
          `Expected AJV rejection keyword in {${[...REJECTION_KEYWORDS].join(',')}}, ` +
            `got: ${JSON.stringify(validate.errors)}`,
        ).toBe(true);
      });
    }

    // -- extra field (relies on additionalProperties:false on the schema) --
    // Only meaningful if the schema sets additionalProperties:false — this
    // is part of the declaration-quality contract, so we assert both.
    it(`${d.key}: AJV rejects an extra field (additionalProperties:false contract)`, () => {
      const broken = { ...sample, __drift_canary__: 'should_not_pass' };
      const ok = validate(broken);
      if (d.tool.inputSchema.additionalProperties === false) {
        expect(
          ok,
          `${d.key}: schema has additionalProperties:false but AJV accepted an extra field.`,
        ).toBe(false);
        const keywords = new Set((validate.errors ?? []).map((e) => e.keyword));
        const hit = [...keywords].some((k) => REJECTION_KEYWORDS.has(k));
        expect(hit).toBe(true);
      } else {
        // Drift-prevention warning: tool schemas SHOULD set additionalProperties:false
        // — otherwise the "undeclared shape rejected" invariant has a hole.
        // We don't fail the test hard here because some plugin/lobby tools
        // didn't originally set it; instead, we log a pointed message and fail
        // the build when the tool is not in the allow-list below.
        const ALLOW_PERMISSIVE = new Set<string>([
          // These tools predate the refactor's additionalProperties:false
          // convention. A future PR can tighten their schemas; until then,
          // the invariant is weaker but the allow-list keeps it explicit.
          'capture-the-lobster.lobby.team-formation:propose_team',
          'capture-the-lobster.lobby.team-formation:accept_team',
          'capture-the-lobster.lobby.team-formation:leave_team',
          'capture-the-lobster.lobby.class-selection:choose_class',
          'plugin:basic-chat:chat',
        ]);
        expect(
          ALLOW_PERMISSIVE.has(d.key),
          `${d.key}: inputSchema must set additionalProperties:false for the drift ` +
            `invariant to hold. Either tighten the schema or add this key to the ` +
            `ALLOW_PERMISSIVE set with a justification.`,
        ).toBe(true);
      }
    });

    // -- wrong type on a typed property --
    const typedProp = Object.entries(props).find(
      ([_, v]) => v && typeof v === 'object' && typeof v.type === 'string',
    );
    if (typedProp) {
      const [propName, propSchema] = typedProp;
      const wrongValue = wrongTypeFor(propSchema.type);
      it(`${d.key}: AJV rejects wrong type on "${propName}" (expected ${propSchema.type})`, () => {
        const broken = { ...sample, [propName]: wrongValue };
        const ok = validate(broken);
        expect(
          ok,
          `${d.key}: AJV accepted "${propName}": ${JSON.stringify(wrongValue)} ` +
            `when the schema declares type: "${propSchema.type}"`,
        ).toBe(false);
        const keywords = new Set((validate.errors ?? []).map((e) => e.keyword));
        const hit = [...keywords].some((k) => REJECTION_KEYWORDS.has(k));
        expect(hit).toBe(true);
      });
    }
  }
});

/** Produce a value that is deliberately the wrong type for a given JSON Schema type. */
// biome-ignore lint/suspicious/noExplicitAny: drift tests reach into both CtL + OATHBREAKER state shapes via a generic harness; the alternative is duplicating each plugin's internal state types in this file.
function wrongTypeFor(type: string): any {
  switch (type) {
    case 'string':
      return 42;
    case 'number':
    case 'integer':
      return 'not-a-number';
    case 'boolean':
      return 'not-a-boolean';
    case 'array':
      return { nope: true };
    case 'object':
      return 'not-an-object';
    default:
      return Symbol('unknown');
  }
}

// ---------------------------------------------------------------------------
// Invariant 3 — System-action isolation
// ---------------------------------------------------------------------------

describe('Invariant 3 — system-action isolation', () => {
  // -- 3a: every system action rejects ANY non-null playerId --
  for (const game of GAMES) {
    const systemTypes = SYSTEM_ACTIONS[game.gameType] ?? [];
    for (const type of systemTypes) {
      it(`${game.gameType}:${type}: validateAction rejects non-null playerId`, () => {
        // Build a state where the system action *would* be valid with null
        // playerId — so the ONLY way it rejects below is the null-gate.
        const state =
          game.gameType === CTL_GAME_ID
            ? buildCtlPreGameState() // pre_game → game_start valid with null
            : buildOathWaitingState(); // waiting → game_start valid with null
        // For 'turn_timeout' / 'round_timeout' we need the in-progress/playing
        // phase. Swap to a state where each system action could plausibly fire.
        const stateForType = (() => {
          if (game.gameType === CTL_GAME_ID && type === 'turn_timeout') {
            return { ...state, phase: 'in_progress' };
          }
          if (game.gameType === OATH_GAME_ID && type === 'round_timeout') {
            // game_start → phase:'playing'
            return OathbreakerPlugin.applyAction(state, null, { type: 'game_start' }).state;
          }
          return state;
        })();

        // Try with a handful of non-null playerIds — every one must reject.
        const nonNullIds = ['p1', 'op1', 'nonexistent', 'attacker'];
        for (const pid of nonNullIds) {
          // biome-ignore lint/suspicious/noExplicitAny: drift tests reach into both CtL + OATHBREAKER state shapes via a generic harness; the alternative is duplicating each plugin's internal state types in this file.
          const accepted = game.validateAction(stateForType, pid, { type } as any);
          expect(
            accepted,
            `${game.gameType}: system action "${type}" must reject non-null playerId ` +
              `"${pid}". If this is actually a player-callable tool, move it from ` +
              `SYSTEM_ACTION_TYPES to gameTools.`,
          ).toBe(false);
        }
      });
    }
  }

  // -- 3b: every gameTool rejects null playerId --
  for (const d of DISCOVERED) {
    if (d.source.kind !== 'game') continue; // only gameTools go through validateAction
    const entry = DRIFT_FIXTURES[d.key];
    if (!entry || entry.kind !== 'game') continue;
    const f = entry.fixture as GameToolFixture;

    it(`${d.key}: validateAction rejects playerId=null`, () => {
      const { state } = f.buildState();
      const action = { type: d.name, ...f.validSample };
      // biome-ignore lint/suspicious/noExplicitAny: drift tests reach into both CtL + OATHBREAKER state shapes via a generic harness; the alternative is duplicating each plugin's internal state types in this file.
      const accepted = f.game.validateAction(state, null, action as any);
      expect(
        accepted,
        `${d.key}: tool "${d.name}" accepted playerId=null. This is a ` +
          `privilege-escalation hole — the engine can spoof a player move. ` +
          `Add a \`playerId === null\` guard to the validator branch.`,
      ).toBe(false);
    });
  }

  // -- 3c: sanity cross-check — no system action type collides with a tool --
  it('no action type appears in both SYSTEM_ACTION_TYPES and gameTools', () => {
    for (const game of GAMES) {
      const systemTypes = new Set(SYSTEM_ACTIONS[game.gameType] ?? []);
      const toolNames = (game.gameTools ?? []).map((t) => t.name);
      for (const name of toolNames) {
        expect(
          systemTypes.has(name),
          `${game.gameType}: "${name}" appears in BOTH SYSTEM_ACTION_TYPES and ` +
            `gameTools. A single type cannot be both a tool and a system action.`,
        ).toBe(false);
      }
    }
  });
});
