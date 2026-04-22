/**
 * Unified tool-call dispatcher.
 *
 * One endpoint, one dispatcher, routing by declarer. Per
 * docs/plans/unified-tool-surface.md.
 *
 * Wire shape:
 *   POST /api/player/tool { toolName: string, args: object }
 *
 * Dispatch algorithm:
 *   1. NO_SESSION → 401 if the player has no player_sessions row.
 *   2. Build the session's tool registry from:
 *       - game.gameTools                           (declarer = 'game')
 *       - lobby.phases[currentPhase].tools         (declarer = 'lobby')
 *       - plugin-tools handled as a legacy relay   (declarer = 'plugin')
 *   3. UNKNOWN_TOOL → 404 if toolName is not in the union.
 *   4. WRONG_PHASE → 409 if toolName exists but belongs to the other phase.
 *   5. INVALID_ARGS → 400 if args fail inputSchema validation (AJV).
 *   6. Route by declarer:
 *       - game   → GameRoomDO /action with { type: toolName, ...args }
 *       - lobby  → LobbyDO /action with { type: toolName, payload: args }
 *       - plugin → LobbyDO|GameRoomDO /tool with the existing relay envelope
 *
 * Merkle invariant: the action object stored in GameRoomDO._actionLog is
 * `{ type: toolName, ...args }` — byte-identical to the pre-refactor shape.
 */

import type { CoordinationGame, ToolDefinition } from '@coordination-games/engine';
import { getGame } from '@coordination-games/engine';
import type { Env } from './env.js';

// ---------------------------------------------------------------------------
// Error taxonomy
// ---------------------------------------------------------------------------

export type DispatcherErrorCode =
  | 'NO_SESSION'
  | 'UNKNOWN_TOOL'
  | 'WRONG_PHASE'
  | 'INVALID_ARGS'
  | 'VALIDATION_FAILED'
  | 'DISPATCH_FAILED'
  | 'COLLISION';

const STATUS_BY_CODE: Record<DispatcherErrorCode, number> = {
  NO_SESSION: 401,
  UNKNOWN_TOOL: 404,
  WRONG_PHASE: 409,
  INVALID_ARGS: 400,
  VALIDATION_FAILED: 400,
  DISPATCH_FAILED: 500,
  COLLISION: 500,
};

// ─────────────────────────────────────────────────────────────────────────
// Validator factory — lazy-wrap validateArgs into a reusable validator
// ─────────────────────────────────────────────────────────────────────────

interface Validator {
  (value: unknown): boolean;
  errors?: FieldError[];
}

function _getValidator(schema: Record<string, unknown>): Validator {
  const validator = (value: unknown): boolean => {
    const errs = validateArgs(schema, value);
    (validator as Validator).errors = errs;
    return errs.length === 0;
  };
  return validator;
}

function _formatFieldErrors(errs: FieldError[]): { path: string; message: string }[] {
  return errs;
}

export interface DispatcherErrorPayload {
  code: DispatcherErrorCode;
  message: string;
  [extra: string]: unknown;
}

function errorResponse(
  code: DispatcherErrorCode,
  message: string,
  extra: Record<string, unknown> = {},
): Response {
  return Response.json({ error: { code, message, ...extra } }, { status: STATUS_BY_CODE[code] });
}

// ---------------------------------------------------------------------------
// Minimal JSON Schema validator
//
// AJV 8 compiles schemas via `new Function()`, which Cloudflare Workers blocks
// at runtime (Error 1101). We only use a small subset of JSON Schema for
// ToolDefinition.inputSchema, so a hand-rolled walker is simpler than shipping
// ajv/dist/standalone. Supported keywords: type, properties, required, items,
// enum, minimum, maximum, minItems, maxItems, additionalProperties.
// ---------------------------------------------------------------------------

export interface FieldError {
  path: string;
  message: string;
}

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v;
}

/**
 * Shape of a JSON-Schema node we accept. Hand-rolled against the keywords
 * we actually implement below; unknown keys are ignored.
 */
interface SchemaNode {
  type?: string | string[];
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  items?: SchemaNode;
  required?: string[];
  properties?: Record<string, SchemaNode>;
  additionalProperties?: boolean;
}

function validateSchema(
  schema: SchemaNode | undefined,
  value: unknown,
  path: string,
  errs: FieldError[],
): void {
  if (!schema || typeof schema !== 'object') return;
  const expected = schema.type;
  if (expected) {
    const actual = typeOf(value);
    const matches = Array.isArray(expected)
      ? expected.some((t) => t === actual || (t === 'number' && actual === 'integer'))
      : expected === actual || (expected === 'number' && actual === 'integer');
    if (!matches) {
      errs.push({
        path: path || '/',
        message: `must be ${Array.isArray(expected) ? expected.join(' or ') : expected}`,
      });
      return; // don't recurse into wrong-typed values
    }
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errs.push({ path: path || '/', message: `must be one of ${JSON.stringify(schema.enum)}` });
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      errs.push({ path: path || '/', message: `must be >= ${schema.minimum}` });
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      errs.push({ path: path || '/', message: `must be <= ${schema.maximum}` });
    }
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      errs.push({ path: path || '/', message: `must have >= ${schema.minItems} items` });
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      errs.push({ path: path || '/', message: `must have <= ${schema.maxItems} items` });
    }
    if (schema.items) {
      for (let i = 0; i < value.length; i++) {
        validateSchema(schema.items, value[i], `${path}/${i}`, errs);
      }
    }
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const req of schema.required ?? []) {
      if (!(req in obj))
        errs.push({ path: `${path}/${req}`, message: `must have required property '${req}'` });
    }
    const props = schema.properties ?? {};
    for (const key of Object.keys(obj)) {
      if (key in props) {
        validateSchema(props[key], obj[key], `${path}/${key}`, errs);
      } else if (schema.additionalProperties === false) {
        errs.push({
          path: `${path}/${key}`,
          message: `additional property '${key}' is not allowed`,
        });
      }
    }
  }
}

function validateArgs(schema: Record<string, unknown>, args: unknown): FieldError[] {
  const errs: FieldError[] = [];
  validateSchema(schema as SchemaNode, args, '', errs);
  return errs;
}

// ---------------------------------------------------------------------------
// Session location + tool registry
// ---------------------------------------------------------------------------

export type PlayerLocation =
  | { kind: 'lobby'; lobbyId: string; gameType: string }
  | { kind: 'game'; lobbyId: string; gameId: string; gameType: string };

export interface ToolRegistryEntry {
  tool: ToolDefinition;
  declarer: 'game' | 'lobby';
  /** For lobby phase tools — the phase id. For game tools — undefined. */
  phaseId?: string;
}

export interface SessionRegistry {
  gameType: string;
  /** Identifier of the current phase: 'game' for GameRoomDO, or the LobbyPhase.id. */
  currentPhaseId: string;
  currentPhaseName: string;
  /** Tools *currently* callable. */
  currentTools: ToolDefinition[];
  /** Full declared surface (every phase, every declarer). */
  allTools: Map<string, ToolRegistryEntry>;
  gameTools: ToolDefinition[];
  lobbyPhaseTools: Record<string, ToolDefinition[]>;
}

/**
 * Build the static per-game view of all declared tools (game + every lobby
 * phase). Used by both the dispatcher and the admin introspection endpoint.
 */
export function buildDeclaredToolSurface(
  plugin: CoordinationGame<unknown, unknown, unknown, unknown>,
): {
  gameTools: ToolDefinition[];
  lobbyPhaseTools: Record<string, ToolDefinition[]>;
  allTools: Map<string, ToolRegistryEntry>;
} {
  const gameTools = plugin.gameTools ?? [];
  const lobbyPhaseTools: Record<string, ToolDefinition[]> = {};
  const allTools = new Map<string, ToolRegistryEntry>();

  for (const tool of gameTools) {
    allTools.set(tool.name, { tool, declarer: 'game' });
  }

  for (const phase of plugin.lobby?.phases ?? []) {
    const tools = phase.tools ?? [];
    lobbyPhaseTools[phase.id] = tools;
    for (const tool of tools) {
      // registerGame() already guaranteed no collisions — but be defensive.
      if (!allTools.has(tool.name)) {
        allTools.set(tool.name, { tool, declarer: 'lobby', phaseId: phase.id });
      }
    }
  }

  return { gameTools, lobbyPhaseTools, allTools };
}

// ---------------------------------------------------------------------------
// HTTP helpers for DO forwarding
// ---------------------------------------------------------------------------

function getGameDO(env: Env, gameId: string): DurableObjectStub {
  return env.GAME_ROOM.get(env.GAME_ROOM.idFromName(gameId));
}

function getLobbyDO(env: Env, lobbyId: string): DurableObjectStub {
  return env.LOBBY.get(env.LOBBY.idFromName(lobbyId));
}

/**
 * Build a sub-request for a DO fetch. The DO derives player identity
 * from X-Player-Id — never from the body — so callers pass it here.
 * Pass null for system/internal calls.
 */
function doRequest(
  method: string,
  path: string,
  body: unknown,
  playerId: string | null,
  query = '',
): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (playerId !== null) headers['X-Player-Id'] = playerId;
  return new Request(`https://do${path}${query}`, {
    method,
    headers,
    body: JSON.stringify(body),
  });
}

/**
 * Pass-through client cursors for tool responses. Every tool call returns a
 * full state envelope; the client echoes its last-seen `sinceIdx` +
 * `knownStateVersion` as URL query params so the response is delta-only
 * (relay envelopes since sinceIdx; `state: null` when stateVersion matches).
 * Missing or malformed values fall through to "full state" on the DO side.
 */
function forwardCursorsQuery(request: Request): string {
  const url = new URL(request.url);
  const sinceIdx = url.searchParams.get('sinceIdx');
  const knownStateVersion = url.searchParams.get('knownStateVersion');
  const parts: string[] = [];
  if (sinceIdx !== null) parts.push(`sinceIdx=${encodeURIComponent(sinceIdx)}`);
  if (knownStateVersion !== null) {
    parts.push(`knownStateVersion=${encodeURIComponent(knownStateVersion)}`);
  }
  return parts.length > 0 ? `?${parts.join('&')}` : '';
}

// ---------------------------------------------------------------------------
// Player location lookup (kept local to avoid a circular import from index.ts)
// ---------------------------------------------------------------------------

export async function getPlayerLocationFromDb(
  playerId: string,
  env: Env,
): Promise<PlayerLocation | null> {
  const row = await env.DB.prepare(
    `SELECT l.id AS lobby_id, l.game_id, l.game_type
     FROM player_sessions ps
     JOIN lobbies l ON l.id = ps.lobby_id
     WHERE ps.player_id = ?`,
  )
    .bind(playerId)
    .first<{ lobby_id: string; game_id: string | null; game_type: string }>();

  if (!row) return null;
  if (row.game_id) {
    return { kind: 'game', lobbyId: row.lobby_id, gameId: row.game_id, gameType: row.game_type };
  }
  return { kind: 'lobby', lobbyId: row.lobby_id, gameType: row.game_type };
}

// ---------------------------------------------------------------------------
// Session registry builder
// ---------------------------------------------------------------------------

/**
 * Build the session's live tool registry for the location the player is in.
 * Throws Response if the registry cannot be built (e.g. missing plugin).
 */
async function buildSessionRegistry(
  location: PlayerLocation,
  env: Env,
  playerId: string,
): Promise<SessionRegistry | Response> {
  const plugin = getGame(location.gameType);
  if (!plugin) {
    return errorResponse('DISPATCH_FAILED', `Unknown game type: ${location.gameType}`, {});
  }

  const { gameTools, lobbyPhaseTools, allTools } = buildDeclaredToolSurface(plugin);

  let currentPhaseId: string;
  let currentPhaseName: string;
  let currentTools: ToolDefinition[];

  if (location.kind === 'game') {
    currentPhaseId = 'game';
    currentPhaseName = 'Game';
    currentTools = gameTools;
  } else {
    // Ask the LobbyDO which phase is current. The DO returns a unified
    // envelope; with X-Player-Id set it includes the auth-only
    // `currentPhase` slice at top level, carrying the current phase's
    // callable tool surface.
    const stub = getLobbyDO(env, location.lobbyId);
    let stateResp: Response;
    try {
      stateResp = await stub.fetch(
        new Request('https://do/state', {
          method: 'GET',
          headers: { 'X-Player-Id': playerId },
        }),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return errorResponse('DISPATCH_FAILED', `LobbyDO unreachable: ${msg}`, {});
    }
    if (!stateResp.ok) {
      return errorResponse('DISPATCH_FAILED', `LobbyDO /state returned ${stateResp.status}`, {});
    }
    const envelope = (await stateResp.json()) as {
      type?: string;
      currentPhase?: { id?: string; name?: string; tools?: ToolDefinition[] };
    } | null;
    const phase = envelope?.currentPhase;
    if (!phase?.id) {
      return errorResponse('DISPATCH_FAILED', 'Lobby has no current phase', {});
    }
    currentPhaseId = phase.id;
    currentPhaseName = phase.name ?? phase.id;
    currentTools = Array.isArray(phase.tools) ? phase.tools : [];
  }

  return {
    gameType: location.gameType,
    currentPhaseId,
    currentPhaseName,
    currentTools,
    allTools,
    gameTools,
    lobbyPhaseTools,
  };
}

// ---------------------------------------------------------------------------
// Structured logging
// ---------------------------------------------------------------------------

export type ToolCallValidation =
  | 'ok'
  | 'unknown'
  | 'wrong_phase'
  | 'invalid_args'
  | 'validation_failed'
  | 'dispatch_failed';

interface ToolCallLog {
  sessionId: string;
  playerId: string;
  toolName: string;
  declarer: 'game' | 'lobby' | 'plugin' | 'unknown';
  phaseAtDispatch: string;
  validationResult: ToolCallValidation;
  latencyMs: number;
  errorCode?: DispatcherErrorCode;
  errorMessage?: string;
}

function logToolCall(entry: ToolCallLog): void {
  console.log(`tool.call ${JSON.stringify(entry)}`);
}

// ---------------------------------------------------------------------------
// Plugin-tool handling (legacy relay envelope, preserved as the 'plugin'
// declarer for the unified endpoint).
//
// The pre-refactor /api/player/tool and /api/player/lobby/tool endpoints
// accepted `{ relay: { type, data, scope, pluginId } }` and dumbly forwarded
// the relay to the active DO. We keep that exact shape when the caller opts
// in via `toolName === 'plugin_relay'` or when args contains a top-level
// `relay` field — this lets client-side plugins keep working unchanged.
// ---------------------------------------------------------------------------

const PLUGIN_RELAY_TOOL_NAME = 'plugin_relay';

function isPluginRelayCall(toolName: string, args: unknown): boolean {
  if (toolName === PLUGIN_RELAY_TOOL_NAME) return true;
  // Convenience: if args carries a `relay` envelope with type+pluginId, treat
  // as a plugin relay. This is what client-side plugins produce via
  // `plugin.handleCall()`.
  if (!args || typeof args !== 'object') return false;
  const relay = (args as { relay?: unknown }).relay;
  if (!relay || typeof relay !== 'object') return false;
  const r = relay as { type?: unknown; pluginId?: unknown };
  return !!(r.type && r.pluginId);
}

// ---------------------------------------------------------------------------
// Main dispatcher
// ---------------------------------------------------------------------------

export interface DispatchInput {
  playerId: string;
  toolName: unknown;
  args: unknown;
}

export async function dispatchToolCall(
  playerId: string,
  request: Request,
  env: Env,
): Promise<Response> {
  const started = Date.now();

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return errorResponse('INVALID_ARGS', 'Invalid JSON body', { fieldErrors: [] });
  }

  const toolName = body?.toolName;
  const args = (body?.args ?? {}) as Record<string, unknown>;
  const cursorsQuery = forwardCursorsQuery(request);

  if (typeof toolName !== 'string' || toolName.length === 0) {
    return errorResponse('INVALID_ARGS', 'toolName is required and must be a string', {
      fieldErrors: [{ path: '/toolName', message: 'must be a non-empty string' }],
    });
  }
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return errorResponse('INVALID_ARGS', 'args must be an object', {
      fieldErrors: [{ path: '/args', message: 'must be an object' }],
    });
  }

  // ── 1. Session lookup ───────────────────────────────────────────────────
  const location = await getPlayerLocationFromDb(playerId, env);
  if (!location) {
    const res = errorResponse('NO_SESSION', 'No active lobby or game for this player', {});
    logToolCall({
      sessionId: 'none',
      playerId,
      toolName,
      declarer: 'unknown',
      phaseAtDispatch: 'none',
      validationResult: 'dispatch_failed',
      latencyMs: Date.now() - started,
      errorCode: 'NO_SESSION',
      errorMessage: 'No active lobby or game for this player',
    });
    return res;
  }

  const sessionId = location.kind === 'game' ? location.gameId : location.lobbyId;

  // ── Plugin relay shortcut (legacy ToolPlugin.handleCall relay post) ─────
  if (isPluginRelayCall(toolName, args)) {
    const relay = (args as { relay?: { type?: string; pluginId?: string } }).relay;
    if (!relay?.type || !relay?.pluginId) {
      const res = errorResponse(
        'INVALID_ARGS',
        'Plugin relay requires { relay: { type, pluginId, data?, scope? } }',
        {
          fieldErrors: [{ path: '/args/relay', message: 'missing type or pluginId' }],
        },
      );
      logToolCall({
        sessionId,
        playerId,
        toolName,
        declarer: 'plugin',
        phaseAtDispatch: location.kind === 'game' ? 'game' : 'lobby',
        validationResult: 'invalid_args',
        latencyMs: Date.now() - started,
        errorCode: 'INVALID_ARGS',
        errorMessage: 'missing relay envelope fields',
      });
      return res;
    }
    const stub =
      location.kind === 'game'
        ? getGameDO(env, location.gameId)
        : getLobbyDO(env, location.lobbyId);
    try {
      const resp = await stub.fetch(doRequest('POST', '/tool', { relay }, playerId, cursorsQuery));
      logToolCall({
        sessionId,
        playerId,
        toolName,
        declarer: 'plugin',
        phaseAtDispatch: location.kind === 'game' ? 'game' : 'lobby',
        validationResult: resp.ok ? 'ok' : 'dispatch_failed',
        latencyMs: Date.now() - started,
      });
      return resp;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logToolCall({
        sessionId,
        playerId,
        toolName,
        declarer: 'plugin',
        phaseAtDispatch: location.kind === 'game' ? 'game' : 'lobby',
        validationResult: 'dispatch_failed',
        latencyMs: Date.now() - started,
        errorCode: 'DISPATCH_FAILED',
        errorMessage: msg,
      });
      return errorResponse('DISPATCH_FAILED', `Plugin relay DO unreachable: ${msg}`, {
        sessionId,
      });
    }
  }

  // ── 2. Build registry ───────────────────────────────────────────────────
  const registryOrResp = await buildSessionRegistry(location, env, playerId);
  if (registryOrResp instanceof Response) return registryOrResp;
  const registry = registryOrResp;

  // ── 3. Unknown tool? ────────────────────────────────────────────────────
  const entry = registry.allTools.get(toolName);
  if (!entry) {
    const validNow = registry.currentTools.map((t) => t.name);
    const res = errorResponse(
      'UNKNOWN_TOOL',
      `Tool "${toolName}" is not declared by game "${registry.gameType}"`,
      {
        validToolsNow: validNow,
      },
    );
    logToolCall({
      sessionId,
      playerId,
      toolName,
      declarer: 'unknown',
      phaseAtDispatch: registry.currentPhaseId,
      validationResult: 'unknown',
      latencyMs: Date.now() - started,
      errorCode: 'UNKNOWN_TOOL',
    });
    return res;
  }

  // ── 4. Wrong phase? ─────────────────────────────────────────────────────
  const toolInCurrentPhase = registry.currentTools.some((t) => t.name === toolName);
  if (!toolInCurrentPhase) {
    const validNow = registry.currentTools.map((t) => t.name);
    const declaredIn =
      entry.declarer === 'game' ? 'the game phase' : `lobby phase "${entry.phaseId ?? '?'}"`;
    const res = errorResponse(
      'WRONG_PHASE',
      `Tool "${toolName}" is declared by ${declaredIn}; current phase is "${registry.currentPhaseId}"`,
      { currentPhase: registry.currentPhaseId, validToolsNow: validNow },
    );
    logToolCall({
      sessionId,
      playerId,
      toolName,
      declarer: entry.declarer,
      phaseAtDispatch: registry.currentPhaseId,
      validationResult: 'wrong_phase',
      latencyMs: Date.now() - started,
      errorCode: 'WRONG_PHASE',
    });
    return res;
  }

  // ── 5. inputSchema validation ───────────────────────────────────────────
  const fieldErrors = validateArgs(entry.tool.inputSchema as Record<string, unknown>, args);
  if (fieldErrors.length > 0) {
    const res = errorResponse(
      'INVALID_ARGS',
      `Arguments do not match the schema for "${toolName}"`,
      { fieldErrors },
    );
    logToolCall({
      sessionId,
      playerId,
      toolName,
      declarer: entry.declarer,
      phaseAtDispatch: registry.currentPhaseId,
      validationResult: 'invalid_args',
      latencyMs: Date.now() - started,
      errorCode: 'INVALID_ARGS',
    });
    return res;
  }

  // ── 6. Route by declarer ────────────────────────────────────────────────
  try {
    if (entry.declarer === 'game') {
      if (location.kind !== 'game') {
        // Shouldn't happen — wrong-phase would have caught it — but handle defensively.
        const res = errorResponse('WRONG_PHASE', 'Game tool called outside game phase', {
          currentPhase: registry.currentPhaseId,
          validToolsNow: registry.currentTools.map((t) => t.name),
        });
        logToolCall({
          sessionId,
          playerId,
          toolName,
          declarer: 'game',
          phaseAtDispatch: registry.currentPhaseId,
          validationResult: 'wrong_phase',
          latencyMs: Date.now() - started,
          errorCode: 'WRONG_PHASE',
        });
        return res;
      }

      // Merkle invariant: action = { type: toolName, ...args } — byte-identical
      // to the pre-refactor /api/player/move shape. `additionalProperties: false`
      // on the ToolDefinition.inputSchema prevents args from carrying its own
      // `type` field, so the spread is safe.
      const action = { type: toolName, ...(args as Record<string, unknown>) };

      const stub = getGameDO(env, location.gameId);
      const resp = await stub.fetch(
        doRequest('POST', '/action', { action }, playerId, cursorsQuery),
      );

      const bodyClone = (await resp
        .clone()
        .json()
        .catch(() => null)) as { success?: boolean; error?: string } | null;
      // GameRoomDO /action returns 500 on throw and 200 { success: false } on
      // validateAction rejection. Translate the rejection into VALIDATION_FAILED.
      if (resp.ok && bodyClone && bodyClone.success === false) {
        const validatorMessage = bodyClone.error ?? 'validateAction rejected the action';
        const res = errorResponse(
          'VALIDATION_FAILED',
          `Game rejected "${toolName}": ${validatorMessage}`,
          { validatorMessage },
        );
        logToolCall({
          sessionId,
          playerId,
          toolName,
          declarer: 'game',
          phaseAtDispatch: 'game',
          validationResult: 'validation_failed',
          latencyMs: Date.now() - started,
          errorCode: 'VALIDATION_FAILED',
          errorMessage: validatorMessage,
        });
        return res;
      }
      if (!resp.ok) {
        const msg = bodyClone?.error ?? `GameRoomDO returned ${resp.status}`;
        const res = errorResponse('DISPATCH_FAILED', String(msg), { sessionId });
        logToolCall({
          sessionId,
          playerId,
          toolName,
          declarer: 'game',
          phaseAtDispatch: 'game',
          validationResult: 'dispatch_failed',
          latencyMs: Date.now() - started,
          errorCode: 'DISPATCH_FAILED',
          errorMessage: String(msg),
        });
        return res;
      }

      logToolCall({
        sessionId,
        playerId,
        toolName,
        declarer: 'game',
        phaseAtDispatch: 'game',
        validationResult: 'ok',
        latencyMs: Date.now() - started,
      });
      return Response.json({ ok: true, ...(bodyClone ?? {}) });
    }

    // declarer === 'lobby'
    if (location.kind !== 'lobby') {
      const res = errorResponse('WRONG_PHASE', 'Lobby tool called outside lobby phase', {
        currentPhase: registry.currentPhaseId,
        validToolsNow: registry.currentTools.map((t) => t.name),
      });
      logToolCall({
        sessionId,
        playerId,
        toolName,
        declarer: 'lobby',
        phaseAtDispatch: registry.currentPhaseId,
        validationResult: 'wrong_phase',
        latencyMs: Date.now() - started,
        errorCode: 'WRONG_PHASE',
      });
      return res;
    }

    const stub = getLobbyDO(env, location.lobbyId);
    // LobbyPhase.handleAction expects { type, playerId, payload }; the
    // LobbyDO /action handler reads playerId from the X-Player-Id header
    // and forwards the rest to the phase.
    const resp = await stub.fetch(
      doRequest('POST', '/action', { type: toolName, payload: args }, playerId, cursorsQuery),
    );
    const bodyClone = (await resp
      .clone()
      .json()
      .catch(() => null)) as { error?: string } | null;

    if (!resp.ok) {
      const msg = bodyClone?.error ?? `LobbyDO returned ${resp.status}`;
      // 400/409 from phase.handleAction → VALIDATION_FAILED
      if (resp.status === 400 || resp.status === 409) {
        const res = errorResponse(
          'VALIDATION_FAILED',
          `Lobby phase rejected "${toolName}": ${msg}`,
          { validatorMessage: String(msg) },
        );
        logToolCall({
          sessionId,
          playerId,
          toolName,
          declarer: 'lobby',
          phaseAtDispatch: registry.currentPhaseId,
          validationResult: 'validation_failed',
          latencyMs: Date.now() - started,
          errorCode: 'VALIDATION_FAILED',
          errorMessage: String(msg),
        });
        return res;
      }
      const res = errorResponse('DISPATCH_FAILED', String(msg), { sessionId });
      logToolCall({
        sessionId,
        playerId,
        toolName,
        declarer: 'lobby',
        phaseAtDispatch: registry.currentPhaseId,
        validationResult: 'dispatch_failed',
        latencyMs: Date.now() - started,
        errorCode: 'DISPATCH_FAILED',
        errorMessage: String(msg),
      });
      return res;
    }

    logToolCall({
      sessionId,
      playerId,
      toolName,
      declarer: 'lobby',
      phaseAtDispatch: registry.currentPhaseId,
      validationResult: 'ok',
      latencyMs: Date.now() - started,
    });
    return Response.json(bodyClone ?? { ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logToolCall({
      sessionId,
      playerId,
      toolName,
      declarer: entry.declarer,
      phaseAtDispatch: registry.currentPhaseId,
      validationResult: 'dispatch_failed',
      latencyMs: Date.now() - started,
      errorCode: 'DISPATCH_FAILED',
      errorMessage: msg,
    });
    return errorResponse('DISPATCH_FAILED', `Dispatch threw: ${msg}`, { sessionId });
  }
}

// ---------------------------------------------------------------------------
// Admin introspection
// ---------------------------------------------------------------------------

/**
 * GET /api/admin/session/:id/tools — returns the full live tool registry for a
 * session. The `:id` is either a lobbyId or a gameId.
 *
 * Auth: checks header `X-Admin-Token` against env.ADMIN_TOKEN. If ADMIN_TOKEN
 * is unset, the endpoint returns 503 — require explicit opt-in.
 */
export async function handleAdminSessionTools(
  sessionId: string,
  request: Request,
  env: Env & { ADMIN_TOKEN?: string },
): Promise<Response> {
  const expected = env.ADMIN_TOKEN;
  if (!expected) {
    return Response.json(
      { error: 'Admin endpoint disabled (ADMIN_TOKEN not set)' },
      { status: 503 },
    );
  }
  const provided = request.headers.get('X-Admin-Token');
  if (provided !== expected) {
    return Response.json({ error: 'Invalid admin token' }, { status: 401 });
  }

  // `:id` can be a lobby id or a game id. Try the game path first (lobby has a
  // game_id column when the game started).
  const row = await env.DB.prepare(
    `SELECT l.id AS lobby_id, l.game_id, l.game_type
     FROM lobbies l
     WHERE l.game_id = ?1 OR l.id = ?1
     LIMIT 1`,
  )
    .bind(sessionId)
    .first<{ lobby_id: string; game_id: string | null; game_type: string }>();

  if (!row) {
    return Response.json({ error: 'Session not found', sessionId }, { status: 404 });
  }

  const plugin = getGame(row.game_type);
  if (!plugin) {
    return Response.json({ error: `Unknown game type: ${row.game_type}` }, { status: 500 });
  }

  const { gameTools, lobbyPhaseTools } = buildDeclaredToolSurface(plugin);

  // Determine current phase. If lobby has a game_id, we're in game phase.
  let currentPhase: { id: string; name: string; tools: ToolDefinition[] };
  if (row.game_id && row.game_id === sessionId) {
    currentPhase = { id: 'game', name: 'Game', tools: gameTools };
  } else if (row.game_id) {
    currentPhase = { id: 'game', name: 'Game', tools: gameTools };
  } else {
    // Query the lobby DO for its current phase. Unauth request returns the
    // spectator envelope whose `state.currentPhase.{id,name}` is populated
    // for every lifecycle phase; match against the admin-static tool map.
    const stub = getLobbyDO(env as Env, row.lobby_id);
    try {
      const stateResp = await stub.fetch(new Request('https://do/state', { method: 'GET' }));
      const envelope = stateResp.ok
        ? ((await stateResp.json()) as {
            type?: string;
            state?: { currentPhase?: { id?: string; name?: string } | null };
          } | null)
        : null;
      const phase = envelope?.state?.currentPhase ?? null;
      currentPhase = phase?.id
        ? { id: phase.id, name: phase.name ?? phase.id, tools: lobbyPhaseTools[phase.id] ?? [] }
        : { id: 'unknown', name: 'unknown', tools: [] };
    } catch {
      currentPhase = { id: 'unknown', name: 'unknown', tools: [] };
    }
  }

  return Response.json({
    sessionId,
    gameType: row.game_type,
    currentPhase,
    gameTools,
    lobbyPhaseTools,
    pluginTools: [],
  });
}
