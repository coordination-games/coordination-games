/**
 * MCP tool registration for the Coordination Games CLI.
 *
 * Single source of truth for the agent-facing tool surface. Post unified-tool-surface
 * cutover, tools are registered dynamically by name — one MCP tool per entry in:
 *
 *   - game.gameTools                 (every registered game)
 *   - game.lobby.phases[*].tools     (every registered game)
 *   - pluginTools with mcpExpose     (client-side ToolPlugin.tools)
 *
 * The full surface is registered at startup (the superset across all phases).
 * Tools that aren't callable in the current phase return a structured
 * WRONG_PHASE error from the server dispatcher — we do NOT dynamically
 * re-register MCP tools when phases change (MCP protocol can't do that cleanly).
 *
 * Auth is handled transparently by GameClient (wallet-based challenge-response).
 * No auth tools are exposed to agents.
 */

import type { CoordinationGame, ToolDefinition, ToolPlugin } from '@coordination-games/engine';
import { CTL_GAME_ID } from '@coordination-games/game-ctl';
import { OATH_GAME_ID } from '@coordination-games/game-oathbreaker';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { GameClient } from './game-client.js';
import type { JsonSchema, PluginCallResult } from './types.js';

/** A CoordinationGame of any shape — the CLI just registers tools by name. */
export type AnyCoordinationGame = CoordinationGame<unknown, unknown, unknown, unknown>;

export interface RegisterToolsOptions {
  /** Active plugins — their mcpExpose tools get registered as MCP tools. */
  plugins?: ToolPlugin[];
  /** Registered games — declared surface used for dynamic MCP tool registration. */
  games?: AnyCoordinationGame[];
}

/** Static top-level CLI commands. Must not collide with any dynamic tool. */
export const STATIC_CLI_COMMANDS: readonly string[] = Object.freeze([
  'init',
  'status',
  'wallet',
  'name',
  'names',
  'serve',
  'verify',
  'lobbies',
  'create-lobby',
  'join',
  'state',
  'wait',
  'guide',
  'tools',
  'tool',
]);

// ---------------------------------------------------------------------------
// Surface collision check (client-side: games + plugins + static CLI)
// ---------------------------------------------------------------------------

/**
 * Client-side collision check: across every dynamic tool we'll register as an
 * MCP tool (gameTools ∪ LobbyPhase.tools ∪ ToolPlugin.tools with mcpExpose:true)
 * AND against the static CLI commands, every name must be unique.
 *
 * Mirrors the server-side `ToolCollisionError` shape so agents see a consistent
 * message regardless of where the collision was caught.
 */
export class ClientToolCollisionError extends Error {
  readonly toolName: string;
  readonly declarers: string[];
  constructor(toolName: string, declarers: string[]) {
    const message =
      `Tool name collision: "${toolName}" is declared by:\n` +
      declarers.map((d) => `  - ${d}`).join('\n') +
      `\n\nResolve by:\n` +
      `  - renaming one of the conflicting tools, or\n` +
      `  - removing one of the colliding plugins from your session config.`;
    super(message);
    this.name = 'ClientToolCollisionError';
    this.toolName = toolName;
    this.declarers = declarers;
  }
}

interface SurfaceEntry {
  tool: ToolDefinition;
  /** Source label for collision error messages. */
  sourceLabel: string;
  kind: 'game' | 'lobby-phase' | 'plugin';
  /** For plugin-sourced entries, the originating plugin (needed for client-side handleCall). */
  plugin?: ToolPlugin;
}

function buildFullSurface(games: AnyCoordinationGame[], plugins: ToolPlugin[]): SurfaceEntry[] {
  const entries: SurfaceEntry[] = [];
  for (const game of games) {
    for (const tool of game.gameTools ?? []) {
      entries.push({ tool, kind: 'game', sourceLabel: `GamePhase of game "${game.gameType}"` });
    }
    for (const phase of game.lobby?.phases ?? []) {
      for (const tool of phase.tools ?? []) {
        entries.push({
          tool,
          kind: 'lobby-phase',
          sourceLabel: `LobbyPhase "${phase.id}" of game "${game.gameType}"`,
        });
      }
    }
  }
  for (const plugin of plugins) {
    for (const tool of plugin.tools ?? []) {
      if (tool.mcpExpose === false) continue;
      // Default to expose-false for plugins (per ToolDefinition.mcpExpose doc).
      // But historically basic-chat opts in with mcpExpose:true. Registration
      // requires an explicit opt-in.
      if (!tool.mcpExpose) continue;
      entries.push({
        tool,
        kind: 'plugin',
        sourceLabel: `ToolPlugin "${plugin.id}"`,
        plugin,
      });
    }
  }
  return entries;
}

function checkSurfaceCollisions(entries: SurfaceEntry[]): void {
  const byName = new Map<string, SurfaceEntry[]>();
  for (const e of entries) {
    const list = byName.get(e.tool.name) ?? [];
    list.push(e);
    byName.set(e.tool.name, list);
  }

  const staticSet = new Set(STATIC_CLI_COMMANDS);
  for (const [name, list] of byName.entries()) {
    const staticCollision = staticSet.has(name);
    if (list.length > 1 || staticCollision) {
      const declarers = list.map((e) => e.sourceLabel);
      if (staticCollision) declarers.push('static CLI command');
      throw new ClientToolCollisionError(name, declarers);
    }
  }
}

// ---------------------------------------------------------------------------
// JSON Schema → zod converter (subset sufficient for ToolDefinition.inputSchema)
// ---------------------------------------------------------------------------

/**
 * Convert a JSON Schema property (the value of inputSchema.properties[k]) into
 * a zod schema. Covers the shapes we actually use in game + lobby + plugin
 * tool definitions:
 *   - `{ type: 'string', enum?, description? }`
 *   - `{ type: 'number' | 'integer' }`
 *   - `{ type: 'boolean' }`
 *   - `{ type: 'array', items: <schema> }`
 *   - `{ type: 'object', properties?, required? }`
 *   - `{ oneOf: [...] }` / `{ anyOf: [...] }` → z.union
 *
 * Unknown shapes fall back to z.any() with the description attached.
 */
function jsonPropToZod(prop: JsonSchema | undefined): z.ZodTypeAny {
  if (!prop || typeof prop !== 'object') return z.any();

  const desc = typeof prop.description === 'string' ? prop.description : undefined;
  const attach = (s: z.ZodTypeAny) => (desc ? s.describe(desc) : s);

  if (Array.isArray(prop.oneOf) || Array.isArray(prop.anyOf)) {
    const variants = (prop.oneOf ?? prop.anyOf ?? []).map(jsonPropToZod);
    if (variants.length === 1 && variants[0]) return attach(variants[0]);
    // z.union requires at least 2 schemas — safe since we checked.
    return attach(z.union(variants as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]));
  }

  if (Array.isArray(prop.type)) {
    const variants = prop.type.map((t) => jsonPropToZod({ ...prop, type: t }));
    if (variants.length === 1 && variants[0]) return attach(variants[0]);
    return attach(z.union(variants as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]));
  }

  const type = prop.type;

  if (type === 'string') {
    if (Array.isArray(prop.enum) && prop.enum.length > 0) {
      return attach(z.enum(prop.enum as [string, ...string[]]));
    }
    return attach(z.string());
  }

  if (type === 'number' || type === 'integer') {
    let s: z.ZodNumber = z.number();
    if (typeof prop.minimum === 'number') s = s.min(prop.minimum);
    if (typeof prop.maximum === 'number') s = s.max(prop.maximum);
    if (type === 'integer') s = s.int();
    return attach(s);
  }

  if (type === 'boolean') return attach(z.boolean());

  if (type === 'array') {
    const items = prop.items ? jsonPropToZod(prop.items) : z.any();
    return attach(z.array(items));
  }

  if (type === 'object') {
    const shape: Record<string, z.ZodTypeAny> = {};
    const props = prop.properties ?? {};
    const required = new Set<string>(Array.isArray(prop.required) ? prop.required : []);
    for (const [k, v] of Object.entries(props)) {
      let zs = jsonPropToZod(v);
      if (!required.has(k)) zs = zs.optional();
      shape[k] = zs;
    }
    return attach(z.object(shape));
  }

  return attach(z.any());
}

/**
 * Build the per-property zod shape map that `McpServer.tool()` expects from a
 * top-level `inputSchema` object (which is always `{type:'object', properties, required}`).
 */
function toolInputShape(
  inputSchema: Record<string, unknown> | undefined,
): Record<string, z.ZodTypeAny> {
  if (!inputSchema || typeof inputSchema !== 'object') return {};
  const schema = inputSchema as JsonSchema;
  const props = schema.properties ?? {};
  const required = new Set<string>(Array.isArray(schema.required) ? schema.required : []);
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [k, v] of Object.entries(props)) {
    let zs = jsonPropToZod(v);
    if (!required.has(k)) zs = zs.optional();
    shape[k] = zs;
  }
  return shape;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register all game tools on an MCP server backed by a GameClient.
 * Auth is handled by GameClient's auto-auth — no signin/register tools needed.
 */
export function registerGameTools(
  server: McpServer,
  client: GameClient,
  options?: RegisterToolsOptions,
): void {
  const games = options?.games ?? [];
  const plugins = options?.plugins ?? [];

  // Build + collision-check the full surface up front. Hard error at startup
  // on any collision (name duplication across games/phases/plugins, or
  // collision with a static CLI command).
  const surface = buildFullSurface(games, plugins);
  checkSurfaceCollisions(surface);

  // ---------------------------------------------------------------------------
  // Static built-ins
  // ---------------------------------------------------------------------------

  server.tool(
    'guide',
    'Get the game rules, your current status, and available tools. Pass game name to get a specific guide.',
    {
      game: z
        .string()
        .optional()
        .describe(`Game name (e.g. "${CTL_GAME_ID}", "${OATH_GAME_ID}"). Auto-detects if omitted.`),
    },
    async (args) => {
      try {
        const result = await client.getGuide(args.game);
        return jsonResult(result);
      } catch (err) {
        return jsonError(err);
      }
    },
  );

  server.tool(
    'state',
    'Get current game or lobby state (fog-of-war filtered). Includes `currentPhase.tools` — the list of tool names callable *right now*. Normally the client caches state and requests only deltas from the server; pass `fresh: true` to bypass the cache and force a full re-sync (rarely needed — use only if you suspect the cache is stale).',
    {
      fresh: z
        .boolean()
        .optional()
        .describe('Bypass client-side state cache and refetch full state'),
    },
    async ({ fresh }) => {
      try {
        const result = await client.getState({ fresh });
        return jsonResult(result);
      } catch (err) {
        return jsonError(err);
      }
    },
  );

  server.tool(
    'wait',
    'Main game loop — blocks until the next event (turn change, chat, phase transition)',
    {},
    async () => {
      try {
        const result = await client.waitForUpdate();
        return jsonResult(result);
      } catch (err) {
        return jsonError(err);
      }
    },
  );

  server.tool('lobbies', 'List available game lobbies', {}, async () => {
    try {
      const result = await client.listLobbies();
      return jsonResult(result);
    } catch (err) {
      return jsonError(err);
    }
  });

  server.tool(
    'join',
    'Join an existing lobby by ID',
    { lobbyId: z.string().describe('The lobby ID to join') },
    async ({ lobbyId }) => {
      try {
        const result = await client.joinLobby(lobbyId);
        return jsonResult(result);
      } catch (err) {
        return jsonError(err);
      }
    },
  );

  server.tool(
    'create_lobby',
    'Create a new lobby (you are auto-joined)',
    {
      gameType: z
        .string()
        .optional()
        .describe(
          `Game type (e.g. "${CTL_GAME_ID}", "${OATH_GAME_ID}"). Defaults to ${CTL_GAME_ID}.`,
        ),
      teamSize: z
        .number()
        .min(2)
        .max(6)
        .optional()
        .describe('Players per team for CtL (2-6, default 2)'),
      playerCount: z
        .number()
        .min(4)
        .max(20)
        .optional()
        .describe('Number of players for OATHBREAKER (4-20, default 4)'),
    },
    async ({ gameType, teamSize, playerCount }) => {
      try {
        const game = gameType || CTL_GAME_ID;
        const size = game === OATH_GAME_ID ? playerCount || 4 : teamSize || 2;
        const result = await client.createLobby(game, size);
        return jsonResult(result);
      } catch (err) {
        return jsonError(err);
      }
    },
  );

  // Phase 5.2: ELO tools (`get_leaderboard`, `get_my_stats`) used to be
  // hard-coded here; they now come from the dynamic plugin registration
  // path below — no per-plugin static stubs in the CLI.

  // ---------------------------------------------------------------------------
  // Dynamic per-name tools from the declared surface
  //
  // We register the superset across all games and all lobby phases. Tools not
  // callable in the current phase return structured WRONG_PHASE from the
  // server dispatcher. See docs/plans/unified-tool-surface.md "MCP surface".
  // ---------------------------------------------------------------------------

  for (const entry of surface) {
    const tool = entry.tool;
    const toolName = tool.name;
    const shape = toolInputShape(tool.inputSchema);

    if (entry.kind === 'plugin' && entry.plugin) {
      const plugin = entry.plugin;
      server.tool(toolName, tool.description, shape, async (args: Record<string, unknown>) => {
        // Plugin tools are client-side: run handleCall locally, then post
        // any returned relay envelope to the unified endpoint.
        let out: PluginCallResult | undefined;
        try {
          out = plugin.handleCall?.(toolName, args, {
            id: 'self',
            handle: 'self',
          }) as PluginCallResult | undefined;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return jsonError({
            error: {
              code: 'PLUGIN_ERROR',
              message: `Plugin "${plugin.id}" handleCall threw: ${msg}`,
            },
          });
        }
        if (out && typeof out === 'object' && 'error' in out && out.error) {
          return jsonError(out);
        }
        if (out && typeof out === 'object' && out.relay) {
          try {
            const result = await client.callPluginRelay(out.relay);
            return jsonResult(result);
          } catch (err) {
            // callPluginRelay attaches `structured` for RELAY_UNREACHABLE.
            const structured = (err as { structured?: { error: unknown } } | undefined)?.structured;
            if (structured) return jsonError(structured);
            return jsonError(err);
          }
        }
        // Plugin returned a plain value (no relay post needed).
        return jsonResult(out);
      });
    } else {
      // Game / lobby-phase tool: dispatch through the unified endpoint.
      server.tool(toolName, tool.description, shape, async (args: Record<string, unknown>) => {
        const result = await client.callToolRaw(toolName, args ?? {});
        if (result.ok) return jsonResult(result.data);
        // Structured error — surface it so the agent can self-correct.
        return jsonError({ error: result.error });
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResult(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data) }],
  };
}

function jsonError(err: unknown) {
  // Accept either a thrown Error (from ApiClient) or a structured
  // `{error: {code, message, ...}}` payload from the dispatcher.
  let payload: { error: unknown };
  if (err && typeof err === 'object' && 'error' in err) {
    payload = err as { error: unknown };
  } else {
    const message = err instanceof Error ? err.message : String(err);
    payload = { error: { code: 'CLIENT_ERROR', message } };
  }
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
    isError: true,
  };
}
