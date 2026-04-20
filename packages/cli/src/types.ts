/**
 * Shared types for the CLI — typed response shapes + JSON-Schema walk type.
 *
 * The server returns plenty of dynamic JSON, but the CLI only walks a handful
 * of fields. Declaring just those fields lets us drop `any` at ~80% of the
 * call sites without pretending we know the whole server payload.
 */

// ---------------------------------------------------------------------------
// JSON Schema (the subset we actually walk in CLI tooling)
// ---------------------------------------------------------------------------

export type JsonSchemaType =
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'array'
  | 'object'
  | 'null';

/**
 * A JSON-Schema-like shape covering everything the CLI touches:
 *   - top-level `inputSchema` on a ToolDefinition (`{type, properties, required}`)
 *   - per-property descriptors (`{type, description, enum, items, minimum, maximum}`)
 *   - array item descriptors (`items`)
 *   - union descriptors (`oneOf`, `anyOf`) produced by some plugin schemas
 *
 * Anything the CLI doesn't walk is left as optional. `additionalProperties`
 * is preserved because the drift harness asserts on it.
 */
export interface JsonSchema {
  type?: JsonSchemaType | JsonSchemaType[];
  description?: string;
  enum?: unknown[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  minimum?: number;
  maximum?: number;
  additionalProperties?: boolean | JsonSchema;
}

// ---------------------------------------------------------------------------
// Server response envelopes (the fields CLI + MCP bridge consume)
// ---------------------------------------------------------------------------

/** Common error envelope returned by server routes. */
export interface ErrorEnvelope {
  error?: { code?: string; message?: string; [k: string]: unknown } | string;
}

/** Response from `/api/relay/status/:address`. */
export interface RelayStatusResponse {
  registered?: boolean;
  name?: string;
  agentId?: string;
  credits?: string | number;
  [k: string]: unknown;
}

/** Response from `/api/relay/check-name/:name`. */
export interface CheckNameResponse {
  available?: boolean;
  suggestions?: string[];
  [k: string]: unknown;
}

/** Response from `/api/relay/register`. */
export interface RegisterNameResponse {
  name?: string;
  agentId?: string;
  credits?: string | number;
  [k: string]: unknown;
}

/** Response from `/api/relay/balance/:agentId`. */
export interface BalanceResponse {
  usdc?: string | number;
  credits?: string | number;
  [k: string]: unknown;
}

/** Response from `/api/relay/burn-request`. */
export interface BurnRequestResponse {
  pendingAmount?: string | number;
  executeAfter?: string | number;
  [k: string]: unknown;
}

/** Response from `/api/relay/burn-execute`. */
export interface BurnExecuteResponse {
  txHash?: string;
  credits?: string | number;
  [k: string]: unknown;
}

/** Challenge payload returned by `/api/player/auth/challenge`. */
export interface AuthChallengeResponse {
  nonce: string;
  message: string;
  [k: string]: unknown;
}

/** Verified-auth payload returned by `/api/player/auth/verify`. */
export interface AuthVerifyResponse {
  token: string;
  [k: string]: unknown;
}

/** A lobby row returned by `/api/lobbies`. */
export interface LobbySummary {
  lobbyId: string;
  gameType: string;
  phase?: string;
  playerCount?: number;
  teamSize?: number;
  gameId?: string | null;
  [k: string]: unknown;
}

/** Response from `/api/lobbies/create`. */
export interface CreateLobbyResponse extends ErrorEnvelope {
  lobbyId?: string;
  gameId?: string;
  playerCount?: number;
  [k: string]: unknown;
}

/** Response from `/api/player/lobby/join`. */
export interface JoinLobbyResponse extends ErrorEnvelope {
  phase?: string;
  [k: string]: unknown;
}

/**
 * Raw server `state` response (before the client pipeline processes it).
 *
 * Game / lobby / plugin payloads are left as `unknown` — consumers narrow per
 * game. What we DO type are the fields the generic CLI surface walks
 * (`gameId`, `currentPhase.tools`, `relayMessages`, `error`).
 */
export interface StateResponse extends ErrorEnvelope {
  gameId?: string;
  currentPhase?: { tools?: import('@coordination-games/engine').ToolDefinition[] };
  relayMessages?: unknown[];
  [k: string]: unknown;
}

/** Discriminated response from `POST /api/player/tool`. */
export type ToolResult =
  | { ok: true; data: unknown }
  | { ok: false; error: { code: string; message: string; [k: string]: unknown } };

/** Result shape produced by a ToolPlugin's `handleCall`. */
export interface PluginCallResult {
  error?: { code?: string; message?: string; [k: string]: unknown };
  relay?: { type: string; pluginId: string; data?: unknown; scope?: string };
  [k: string]: unknown;
}

// ---------------------------------------------------------------------------
// Verify bundle shapes (`/api/games/:id/bundle` + `/api/games/:id/result`)
// ---------------------------------------------------------------------------

export interface BundleMove {
  player: string;
  data: unknown;
  signature: string;
}

export interface BundleTurn {
  turnNumber: number;
  moves: BundleMove[];
  result?: unknown;
}

export interface GameBundle {
  config?: Record<string, unknown>;
  turns?: BundleTurn[];
  moveSchema?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface OnChainResult {
  configHash?: string;
  movesRoot?: string;
  turnCount?: number | bigint;
  [k: string]: unknown;
}
