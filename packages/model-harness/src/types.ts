/**
 * Shared CONTRACT for the Unified Model Harness.
 *
 * Every other module in this package — spec parser, persona loader, the two
 * AgentRunner backends, the orchestrator, the transcript writer, and the
 * analysis pass — codes against the types declared here. Keep this file the
 * single source of truth for the wire/in-memory shapes; downstream agents own
 * those modules and import from here.
 *
 * Design references: docs/plans/unified-model-harness.md §§4, 5, 6, 8, 9.
 *
 * HARD CONSTRAINT (mirrored from fill-bots): no game-specific shapes ever
 * appear here. Everything game-specific is discovered at runtime via the coga
 * MCP server (guide / state / per-phase tool schemas).
 */

// ---------------------------------------------------------------------------
// Backend selection
// ---------------------------------------------------------------------------

/**
 * Which brain loop drives a seat.
 *  - 'claude'     → spawn the proven `claude --print` subprocess (local
 *                   ~/.claude creds, no API key) talking to coga serve --stdio.
 *  - 'openrouter' → MCP stdio client + OpenAI-style function-calling loop
 *                   against OpenRouter (OPENROUTER_API_KEY).
 */
export type Backend = 'claude' | 'openrouter';

/**
 * Backend selection rule (locked, §6/§12.4), derived purely from the seat's
 * model string — no per-seat backend field exists:
 *
 *   - `openrouter/...`              → 'openrouter' (always; even Anthropic
 *                                     models, to A/B local-creds vs billing).
 *   - `anthropic/<alias>`           → 'claude' (local creds).
 *   - bare claude aliases           → 'claude'
 *       (`claude`, `haiku`, `sonnet`, `opus`, or any `claude-*` / `claude/*`).
 *   - everything else               → 'openrouter'.
 */
export function backendForModel(model: string): Backend {
  const m = model.trim().toLowerCase();
  // Explicit OpenRouter prefix always wins — even for anthropic/* underneath.
  if (m.startsWith('openrouter/')) return 'openrouter';
  // Anthropic-namespaced models run on the local-creds Claude backend.
  if (m.startsWith('anthropic/')) return 'claude';
  if (m.startsWith('claude/')) return 'claude';
  // Bare Claude aliases the `claude` CLI understands directly.
  if (m === 'claude' || m === 'haiku' || m === 'sonnet' || m === 'opus') return 'claude';
  if (m.startsWith('claude-')) return 'claude';
  // Anything else is assumed to be an OpenRouter model id (e.g. openai/gpt-4o,
  // minimax/minimax-m2, google/gemini-...).
  return 'openrouter';
}

/**
 * Map a claude-backend model string to a value the `claude` CLI's `--model`
 * accepts. The incoming string may be:
 *   - `anthropic/claude-haiku` / `claude/claude-sonnet` → strip the routing prefix
 *   - friendly tier alias `claude-haiku|sonnet|opus`     → the CLI rejects these
 *     raw; map to the bare `haiku|sonnet|opus` aliases it understands.
 *   - bare `haiku|sonnet|opus` or a full versioned id     → pass through unchanged
 *     (`claude-haiku-4-5`, `claude-opus-4-8`, …).
 * Shared by the Claude runner (gameplay) and the analysis judge so both resolve
 * aliases identically.
 */
export function claudeCliModel(model: string): string {
  const stripped = model.trim().replace(/^(anthropic|claude)\//i, '');
  const tierAlias: Record<string, string> = {
    'claude-haiku': 'haiku',
    'claude-sonnet': 'sonnet',
    'claude-opus': 'opus',
  };
  return tierAlias[stripped.toLowerCase()] ?? stripped;
}

// ---------------------------------------------------------------------------
// Personas (§5) — a persona is a directory bundle, loaded into this shape.
// ---------------------------------------------------------------------------

export interface LoadedPersona {
  /** Absolute path to the persona bundle directory. */
  dir: string;
  /**
   * The persona's system-prompt fragment: persona.md plus any context/*.md
   * concatenated. Layered on top of BASE_PROTOCOL_PROMPT by the orchestrator.
   * Contains behavior/voice/strategy ONLY — no game-specific tool names/args.
   */
  systemPromptFragment: string;
  /**
   * Optional persona.yaml `defaultModel`. A convenience only — the run-spec's
   * per-seat `model` always wins. Lets the same persona be benchmarked across
   * models.
   */
  defaultModel?: string;
  /**
   * Optional persona.yaml `extraMcpServers`: extra MCP servers the runner also
   * connects/exposes alongside coga. Out-of-the-box personas use none. (v1 may
   * document-but-not-wire these; if so it is noted explicitly — no silent gaps.)
   */
  extraMcpServers?: ExtraMcpServer[];
}

export interface ExtraMcpServer {
  name: string;
  command: string;
  args?: string[];
}

// ---------------------------------------------------------------------------
// Run-spec (§6) — the parsed YAML/JSON that drives a whole batch.
// ---------------------------------------------------------------------------

/** One seat group in the spec; expands to `count` resolved seats. */
export interface SeatSpec {
  /** Path (relative to the spec or absolute) to a persona bundle directory. */
  persona: string;
  /** Backend-specific / prefixed model id. Drives backend selection. */
  model: string;
  /** How many seats this entry expands to. Personas cycle if count > 1. */
  count: number;
}

export interface RunLimits {
  /** Hard cap on model calls per bot before forcing 'cap' termination. */
  maxModelCallsPerBot: number;
  /** Wall-clock budget for the whole run, in milliseconds. */
  wallClockMsPerRun: number;
}

export interface AnalysisSpec {
  enabled: boolean;
  /** Judge model id (any backend, selected via backendForModel). */
  model: string;
  /** Optional override of the default analysis lens set (§10). */
  lenses?: string[];
}

export interface RunSpec {
  /** Game type slug passed to lobby create (e.g. 'tragedy-of-the-commons'). */
  game: string;
  /** Round cap (maps to game config / HARNESS_ROUNDS-equivalent). */
  rounds: number;
  /** Game-specific sizing knobs passed to lobby create (e.g. { teamSize: 4 }). */
  params: Record<string, unknown>;
  /** Server URL (or GAME_SERVER env fallback applied by the parser). */
  server: string;
  /** Identity strategy: fresh wallets per run, or the persistent bot pool. */
  identities: 'ephemeral' | 'pool';
  /** Output directory; a runId subdir is created per run. */
  output: string;
  /** Seat groups; each expands to `count` seats. */
  seats: SeatSpec[];
  /** Per-bot and per-run limits. */
  limits: RunLimits;
  /** Optional automated analysis ("judge") pass config. */
  analysis?: AnalysisSpec;
  /**
   * Optional display label for this run, woven into the run-dir name and the
   * campaign index. Set by the campaign loader (globals/games form); a bare
   * single-spec leaves it unset, so its run dir stays `run-<ts>`.
   */
  label?: string;
}

// ---------------------------------------------------------------------------
// Campaign (globals/games form) — a sequential sweep of batches (§ research).
// Scope is a STRICT PARTITION, not defaults+overrides: campaign-wide fields live
// in `globals`, per-game fields in each `games[]` entry, and no field appears in
// both. The loader rejects a field placed in the wrong section.
// ---------------------------------------------------------------------------

/** One fully-resolved run within a campaign (globals merged, repeats flattened). */
export interface CampaignRun {
  /** The resolved RunSpec, ready for runBatch (with `label` set). */
  spec: RunSpec;
  /** The entry's base label (explicit `label:` or the game slug, de-duped). */
  baseLabel: string;
  /** 1-based index within this entry's repeats. */
  repeatIndex: number;
  /** Total repeats for this entry. */
  repeatTotal: number;
}

// ---------------------------------------------------------------------------
// Resolved seat — one concrete bot the orchestrator will run.
// ---------------------------------------------------------------------------

export interface ResolvedSeat {
  /** Unique bot display name for this run. */
  botName: string;
  /** Bot wallet private key (ephemeral or pool-sourced). */
  privateKey: string;
  /** The loaded persona bundle assigned to this seat. */
  persona: LoadedPersona;
  /** The model id for this seat (per-seat spec value). */
  model: string;
  /** Resolved backend for `model` (backendForModel). */
  backend: Backend;
}

// ---------------------------------------------------------------------------
// Transcript events (§8) — one JSON object per line in bots/<botName>.jsonl.
// Timestamps `t` are wall-clock ms stamped by the harness, never the model.
// ---------------------------------------------------------------------------

export interface ModelRequestEvent {
  t: number;
  bot: string;
  kind: 'model_request';
  model: string;
  /** The messages array sent to the model this call (backend-shaped). */
  messages: unknown;
}

export interface ModelResponseEvent {
  t: number;
  bot: string;
  kind: 'model_response';
  text?: string;
  toolCalls?: { name: string; args: unknown }[];
  usage?: unknown;
}

export interface ToolCallEvent {
  t: number;
  bot: string;
  kind: 'tool_call';
  name: string;
  args: unknown;
}

export interface ToolResultEvent {
  t: number;
  bot: string;
  kind: 'tool_result';
  name: string;
  result: unknown;
  isError?: boolean;
  /**
   * Consequential-action derivation (§9): canonical state version (from the
   * state envelope's ETag / knownStateVersion) and the relay cursor
   * (meta.sinceIdx) observed on this result. A turn is consequential iff the
   * state version advanced across it.
   */
  stateVersion?: number;
  relayCursor?: number;
}

export interface SessionEvent {
  t: number;
  bot: string;
  kind: 'session';
  event: 'start' | 'finished' | 'cap' | 'error';
  detail?: string;
}

export type TranscriptEvent =
  | ModelRequestEvent
  | ModelResponseEvent
  | ToolCallEvent
  | ToolResultEvent
  | SessionEvent;

// ---------------------------------------------------------------------------
// AgentRunner (§4.1) — the backend abstraction. Two implementations
// (ClaudeAgentRunner, OpenRouterAgentRunner). Both connect to the same
// `coga serve --stdio --bot-mode --key --name --server-url` MCP server; neither
// touches REST directly.
// ---------------------------------------------------------------------------

export interface SessionResult {
  /** True iff the bot observed phase:"finished" in a tool result. */
  finished: boolean;
  /** Number of model calls made during the session. */
  modelCalls: number;
  /** Why the session ended. */
  reason: 'finished' | 'cap' | 'error';
}

export interface RunSessionOptions {
  botName: string;
  privateKey: string;
  /** GAME_SERVER URL. */
  server: string;
  /** Pre-assembled prompt: BASE_PROTOCOL_PROMPT + persona. */
  systemPrompt: string;
  /** Backend-specific model id. */
  model: string;
  limits: {
    /** Cap on model calls (resolved from RunLimits.maxModelCallsPerBot). */
    maxModelCalls: number;
    /** Wall-clock budget in ms for this session (RunLimits.wallClockMsPerRun). */
    wallClockMs: number;
  };
  /** Append-only transcript sink (§8). */
  onEvent: (e: TranscriptEvent) => void;
}

export interface AgentRunner {
  /**
   * Drive one bot from "already joined the lobby" to game end, talking to its
   * own coga MCP server. Emits transcript events via onEvent. Resolves when the
   * bot observes phase:"finished" or hits a wall-clock/model-call cap.
   */
  runSession(opts: RunSessionOptions): Promise<SessionResult>;
}
