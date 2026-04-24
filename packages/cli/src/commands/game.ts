import fs from 'node:fs';
import path from 'node:path';
import type { ToolDefinition } from '@coordination-games/engine';
import { CTL_GAME_ID } from '@coordination-games/game-ctl';
import { OATH_GAME_ID } from '@coordination-games/game-oathbreaker';
import { BasicChatPlugin } from '@coordination-games/plugin-chat';
import type { Command } from 'commander';
import { ApiClient } from '../api-client.js';
import { loadConfig, loadSession, saveSession } from '../config.js';
import { GameClient } from '../game-client.js';
import { loadKey } from '../keys.js';
import type { JsonSchema, PluginCallResult } from '../types.js';

/** Narrow a ToolDefinition's `inputSchema` (Record<string, unknown>) to our walkable shape. */
function schemaOf(tool: ToolDefinition): JsonSchema {
  return (tool.inputSchema ?? {}) as JsonSchema;
}

/** Extract a user-facing message from a caught error. */
function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Serialize agent-facing JSON.
 *
 * Default is compact (single-line) — this is the agent-facing path, and
 * pretty-printing roughly triples the byte cost for no agent benefit. Humans
 * who want indented output opt in via `--pretty` on each subcommand that
 * emits JSON.
 */
export function formatJson(value: unknown, pretty: boolean): string {
  return pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value);
}

/**
 * Resolve the player's registered name. Checks session cache first,
 * then fetches from the relay status endpoint and caches for next time.
 */
async function resolveName(
  wallet: { address: string; privateKey: string },
  serverUrl: string,
): Promise<string> {
  const session = loadSession();
  if (session.handle) return session.handle;

  // Fetch name from server
  try {
    const api = new ApiClient(serverUrl);
    const data = await api.getRelayStatus(wallet.address);
    if (data.registered && data.name) {
      session.handle = data.name;
      saveSession(session);
      return data.name;
    }
  } catch {}

  return wallet.address.slice(0, 10);
}

/**
 * Create a GameClient that auto-authenticates using the local wallet.
 */
async function createClient(): Promise<GameClient> {
  const config = loadConfig();
  const wallet = loadKey();
  if (!wallet) {
    process.stderr.write(`\n  No wallet found. Run 'coga init' to create one.\n\n`);
    process.exit(1);
  }

  const session = loadSession();
  const name = await resolveName(wallet, config.serverUrl);

  const options: { privateKey: string; name: string; token?: string } = {
    privateKey: wallet.privateKey,
    name,
  };
  if (session.token) options.token = session.token;
  return new GameClient(config.serverUrl, options);
}

// ---------------------------------------------------------------------------
// Tool registry discovery (server-authoritative + local plugins)
// ---------------------------------------------------------------------------

interface DiscoveredTool {
  tool: ToolDefinition;
  /** 'callable-now' if present in state.currentPhase.tools; 'plugin' for local. */
  source: 'phase' | 'plugin';
  pluginId?: string;
}

/**
 * Build the tool registry for `coga tool` / `coga tools`:
 *
 *   - server's `state.currentPhase.tools` (currently-callable phase tools)
 *   - locally-loaded ToolPlugin.tools (client-side plugins like basic-chat)
 *
 * We return only currently-callable phase tools here (not the superset) —
 * the whole point of `coga tools` is "what can I do right now?".
 */
async function buildCliToolRegistry(client: GameClient): Promise<DiscoveredTool[]> {
  const out: DiscoveredTool[] = [];

  // Server-authoritative phase tools
  try {
    const state = await client.getState();
    const phaseTools = state?.currentPhase?.tools;
    if (Array.isArray(phaseTools)) {
      for (const tool of phaseTools) {
        out.push({ tool, source: 'phase' });
      }
    }
  } catch {
    // No session yet — registry is plugins-only.
  }

  // Local plugins (basic-chat etc.)
  const plugins = [BasicChatPlugin];
  for (const plugin of plugins) {
    for (const tool of plugin.tools ?? []) {
      out.push({ tool, source: 'plugin', pluginId: plugin.id });
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// k=v arg parsing driven by the tool's JSON inputSchema
// ---------------------------------------------------------------------------

function coerceByType(raw: string, propSchema: JsonSchema | undefined): unknown {
  const type = propSchema?.type;
  if (type === 'array') {
    const items = propSchema?.items ?? {};
    return raw === '' ? [] : raw.split(',').map((s) => coerceByType(s.trim(), items));
  }
  if (type === 'number' || type === 'integer') {
    const n = Number(raw);
    if (Number.isNaN(n)) throw new Error(`expected a number, got "${raw}"`);
    return type === 'integer' ? Math.trunc(n) : n;
  }
  if (type === 'boolean') {
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    throw new Error(`expected true/false, got "${raw}"`);
  }
  // string (or enum / unknown) — pass through
  return raw;
}

function parseKvArgs(kvs: string[], inputSchema: JsonSchema | undefined): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const props = inputSchema?.properties ?? {};

  for (const kv of kvs) {
    const eq = kv.indexOf('=');
    if (eq < 0) {
      throw new Error(`Positional arg "${kv}" not supported. Use k=v pairs or --json.`);
    }
    const key = kv.slice(0, eq);
    const rawValue = kv.slice(eq + 1);

    // @file.json → load JSON from file
    if (rawValue.startsWith('@')) {
      const file = rawValue.slice(1);
      const resolved = path.resolve(process.cwd(), file);
      const body = fs.readFileSync(resolved, 'utf8');
      args[key] = JSON.parse(body);
      continue;
    }

    const propSchema = props[key];
    if (!propSchema) {
      // Unknown key — pass as string, server will reject with INVALID_ARGS.
      args[key] = rawValue;
      continue;
    }
    args[key] = coerceByType(rawValue, propSchema);
  }

  return args;
}

function requiredFieldsError(tool: ToolDefinition, args: Record<string, unknown>): string | null {
  const schema = schemaOf(tool);
  const required = schema.required ?? [];
  const missing = required.filter((f) => !(f in args));
  if (missing.length === 0) return null;
  const props = schema.properties ?? {};
  const lines = missing.map((f) => {
    const prop = props[f];
    const desc = prop?.description ? ` — ${prop.description}` : '';
    const type = prop?.type
      ? ` (${Array.isArray(prop.type) ? prop.type.join('|') : prop.type})`
      : '';
    return `    ${f}${type}${desc}`;
  });
  return `Missing required args for "${tool.name}":\n${lines.join('\n')}`;
}

function printToolHelp(tool: ToolDefinition): void {
  process.stdout.write(`\n  ${tool.name}\n`);
  process.stdout.write(`    ${tool.description}\n`);
  const schema = schemaOf(tool);
  const props = schema.properties ?? {};
  const required = new Set<string>(schema.required ?? []);
  const names = Object.keys(props);
  if (names.length === 0) {
    process.stdout.write(`    (no arguments)\n\n`);
    return;
  }
  process.stdout.write(`\n    Arguments:\n`);
  for (const name of names) {
    const p = props[name];
    const type = p?.type ? (Array.isArray(p.type) ? p.type.join('|') : p.type) : 'any';
    const enumNote = Array.isArray(p?.enum) ? ` [${p.enum.join('|')}]` : '';
    const req = required.has(name) ? ' *required*' : '';
    const desc = p?.description ? ` — ${p.description}` : '';
    process.stdout.write(`      ${name}: ${type}${enumNote}${req}${desc}\n`);
  }
  process.stdout.write(`\n`);
}

// ---------------------------------------------------------------------------
// Command registrations
// ---------------------------------------------------------------------------

export function registerGameCommands(program: Command) {
  // ==================== lobbies ====================
  program
    .command('lobbies')
    .description('List available game lobbies')
    .action(async () => {
      const client = await createClient();

      try {
        const lobbies = await client.listLobbies();

        if (!Array.isArray(lobbies) || lobbies.length === 0) {
          process.stdout.write(`\n  No active lobbies.\n\n`);
          return;
        }

        process.stdout.write(`\n  Active Lobbies:\n`);
        for (const lobby of lobbies) {
          const phase = lobby.phase ?? 'lobby';
          process.stdout.write(
            `  [${lobby.lobbyId}] ${lobby.gameType} — ${lobby.playerCount ?? 0}/${lobby.teamSize ?? '?'} players (${phase})\n`,
          );
          if (lobby.gameId) {
            process.stdout.write(`    -> Game started: ${lobby.gameId}\n`);
          }
        }
        process.stdout.write(`\n`);
      } catch (err) {
        process.stderr.write(`  Error: ${errMsg(err)}\n`);
        process.exit(1);
      }
    });

  // ==================== create-lobby ====================
  program
    .command('create-lobby')
    .description('Create a new game lobby')
    .option('-s, --size <n>', 'Team size (2-6) for CtL, player count (4-20) for OATHBREAKER', '2')
    .option('-g, --game <name>', `Game type: ${CTL_GAME_ID} or ${OATH_GAME_ID}`, CTL_GAME_ID)
    .action(async (opts) => {
      const client = await createClient();
      const gameType = opts.game;
      const size = parseInt(opts.size, 10) || 2;

      try {
        const result = await client.createLobby(gameType, size);

        if (result.error) {
          process.stderr.write(`  Error: ${result.error}\n`);
          process.exit(1);
        }

        if (gameType === OATH_GAME_ID) {
          process.stdout.write(`\n  OATHBREAKER game created: ${result.gameId}\n`);
          process.stdout.write(`  Players: ${result.playerCount}\n\n`);
          if (result.gameId) {
            const session = loadSession();
            session.currentGameId = result.gameId;
            saveSession(session);
          }
        } else {
          const lobbyId = result.lobbyId;
          const teamSize = Math.min(6, Math.max(2, size));
          process.stdout.write(`\n  Lobby created: ${lobbyId}\n`);
          process.stdout.write(`  Team size: ${teamSize}v${teamSize}\n\n`);
          if (lobbyId) {
            const session = loadSession();
            session.currentLobbyId = lobbyId;
            saveSession(session);
          }
        }
      } catch (err) {
        process.stderr.write(`  Error: ${errMsg(err)}\n`);
        process.exit(1);
      }
    });

  // ==================== join ====================
  program
    .command('join <lobbyId>')
    .description('Join a game lobby')
    .action(async (lobbyId: string) => {
      const client = await createClient();

      try {
        const result = await client.joinLobby(lobbyId);

        if (result.error) {
          process.stderr.write(`  Error: ${result.error}\n`);
          process.exit(1);
        }

        process.stdout.write(`\n  Joined lobby ${lobbyId}\n`);
        if (result.phase) {
          process.stdout.write(`  Phase: ${result.phase}\n`);
        }
        process.stdout.write(`\n`);

        const session = loadSession();
        session.currentLobbyId = lobbyId;
        saveSession(session);
      } catch (err) {
        process.stderr.write(`  Error: ${errMsg(err)}\n`);
        process.exit(1);
      }
    });

  // ==================== guide ====================
  program
    .command('guide [game]')
    .description('Dynamic playbook — game rules, your plugins, available actions')
    .option('--pretty', 'Pretty-print JSON output with 2-space indent')
    .action(async (game: string | undefined, options: { pretty?: boolean }) => {
      const pretty = Boolean(options.pretty);
      const client = await createClient();

      try {
        const result = await client.getGuide(game);

        if (typeof result === 'object' && result !== null && 'error' in result) {
          const errField = (result as { error?: unknown }).error;
          if (errField) {
            process.stderr.write(`  Error: ${JSON.stringify(errField)}\n`);
            process.exit(1);
          }
        }

        process.stdout.write(typeof result === 'string' ? result : formatJson(result, pretty));
        process.stdout.write('\n');
      } catch (err) {
        process.stderr.write(`  Error: ${errMsg(err)}\n`);
        process.exit(1);
      }
    });

  // ==================== state ====================
  program
    .command('state')
    .description('Get current game/lobby state (processed through your plugin pipeline)')
    .option('--fresh', 'Reset agent persistence (cursor + lastSeen) before fetching')
    .option('--pretty', 'Pretty-print JSON output with 2-space indent')
    .action(async (options: { fresh?: boolean; pretty?: boolean }) => {
      const pretty = Boolean(options.pretty);
      const client = await createClient();

      try {
        const result = await client.getState({ fresh: Boolean(options.fresh) });

        if (result.error) {
          process.stderr.write(`  Error: ${result.error}\n`);
          process.exit(1);
        }

        // Track game ID if present
        if (result.gameId) {
          const session = loadSession();
          session.currentGameId = result.gameId;
          saveSession(session);
        }

        process.stdout.write(`${formatJson(result, pretty)}\n`);
      } catch (err) {
        process.stderr.write(`  Error: ${errMsg(err)}\n`);
        process.exit(1);
      }
    });

  // ==================== wait ====================
  program
    .command('wait')
    .description('Wait for the next game update (long-poll)')
    .option('--fresh', 'Reset agent persistence (cursor + lastSeen) before waiting')
    .option('--pretty', 'Pretty-print JSON output with 2-space indent')
    .action(async (options: { fresh?: boolean; pretty?: boolean }) => {
      const pretty = Boolean(options.pretty);
      const client = await createClient();

      try {
        process.stdout.write('  Waiting for update...\n');
        const result = await client.waitForUpdate({ fresh: Boolean(options.fresh) });

        if (result.error) {
          process.stderr.write(`  Error: ${result.error}\n`);
          process.exit(1);
        }

        // Track game ID if present
        if (result.gameId) {
          const session = loadSession();
          session.currentGameId = result.gameId;
          saveSession(session);
        }

        process.stdout.write(`${formatJson(result, pretty)}\n`);
      } catch (err) {
        process.stderr.write(`  Error: ${errMsg(err)}\n`);
        process.exit(1);
      }
    });

  // ==================== tools ====================
  program
    .command('tools')
    .description('List tools you can call right now (current phase + local plugin tools)')
    .action(async () => {
      const client = await createClient();
      try {
        const registry = await buildCliToolRegistry(client);
        if (registry.length === 0) {
          process.stdout.write(
            `\n  No tools currently callable. Join or create a lobby first.\n\n`,
          );
          return;
        }
        process.stdout.write(`\n  Available tools:\n`);
        for (const d of registry) {
          process.stdout.write(`    ${d.tool.name} — ${d.tool.description}\n`);
        }
        process.stdout.write(`\n  Call with: coga tool <name> k=v [...]\n`);
        process.stdout.write(`  Help for one: coga tool <name> --help\n\n`);
      } catch (err) {
        process.stderr.write(`  Error: ${errMsg(err)}\n`);
        process.exit(1);
      }
    });

  // ==================== tool ====================
  const toolCmd = program
    .command('tool <name> [args...]')
    .description(
      'Invoke a tool by name (game phase tool, lobby phase tool, or plugin tool). ' +
        'Args: k=v, k=v1,v2 (array), k=@file.json (load JSON). ' +
        "Or --json '{...}' for raw passthrough. Use `coga tool <name> --schema` for schema.",
    );
  // Disable the auto-generated --help on this subcommand so we can reserve
  // --schema for printing the tool's inputSchema. Top-level `coga --help` and
  // `coga help tool` still work. The `helpOption` is on Commander's internal
  // command surface (runtime-available) but not typed in @types/commander.
  (toolCmd as unknown as { helpOption: (flag: false) => void }).helpOption(false);
  toolCmd.option('--json <payload>', 'Pass raw JSON args (bypasses k=v parsing)');
  toolCmd.option('--schema', "Print the tool's input schema and exit");
  toolCmd.option('--pretty', 'Pretty-print JSON output with 2-space indent');
  toolCmd.action(
    async (
      name: string,
      rawArgs: string[],
      opts: { json?: string; schema?: boolean; pretty?: boolean },
    ) => {
      const pretty = Boolean(opts?.pretty);
      const client = await createClient();
      let registry: DiscoveredTool[];
      try {
        registry = await buildCliToolRegistry(client);
      } catch (err) {
        process.stderr.write(`  Error building tool registry: ${errMsg(err)}\n`);
        process.exit(1);
        return;
      }

      const found = registry.find((d) => d.tool.name === name);

      // --schema
      if (opts?.schema) {
        if (!found) {
          process.stderr.write(`  Unknown tool "${name}" in the current phase.\n`);
          process.stderr.write(
            `  Tools callable now: ${registry.map((d) => d.tool.name).join(', ') || '(none)'}\n`,
          );
          process.exit(1);
          return;
        }
        printToolHelp(found.tool);
        return;
      }

      if (!found) {
        process.stderr.write(`  Unknown tool "${name}" in the current phase.\n`);
        process.stderr.write(
          `  Tools callable now: ${registry.map((d) => d.tool.name).join(', ') || '(none)'}\n`,
        );
        process.exit(1);
        return;
      }

      // Build args
      let args: Record<string, unknown>;
      if (opts?.json) {
        try {
          args = JSON.parse(opts.json) as Record<string, unknown>;
        } catch (err) {
          process.stderr.write(`  Error: invalid --json payload: ${errMsg(err)}\n`);
          process.exit(1);
          return;
        }
      } else {
        try {
          args = parseKvArgs(rawArgs ?? [], schemaOf(found.tool));
        } catch (err) {
          process.stderr.write(`  Error: ${errMsg(err)}\n`);
          process.exit(1);
          return;
        }
      }

      const missingErr = requiredFieldsError(found.tool, args);
      if (missingErr) {
        process.stderr.write(`  ${missingErr}\n`);
        process.stderr.write(`  Try: coga tool ${name} --schema\n`);
        process.exit(1);
        return;
      }

      // Dispatch
      try {
        if (found.source === 'plugin' && found.pluginId === BasicChatPlugin.id) {
          // Local client-side plugin: run handleCall to get the relay envelope.
          let out: PluginCallResult | undefined;
          try {
            out = BasicChatPlugin.handleCall?.(name, args, {
              id: 'self',
              handle: 'self',
            }) as PluginCallResult | undefined;
          } catch (err) {
            const payload = {
              error: {
                code: 'PLUGIN_ERROR',
                message: `Plugin "${found.pluginId}" handleCall threw: ${errMsg(err)}`,
              },
            };
            process.stdout.write(`${formatJson(payload, pretty)}\n`);
            process.exit(1);
            return;
          }
          if (out?.error) {
            process.stdout.write(`${formatJson(out, pretty)}\n`);
            process.exit(1);
            return;
          }
          if (out?.relay) {
            const result = await client.callPluginRelay(out.relay);
            process.stdout.write(`${formatJson(result, pretty)}\n`);
            return;
          }
          process.stdout.write(`${formatJson(out, pretty)}\n`);
          return;
        }

        // Phase tool (game or lobby) → unified endpoint
        const result = await client.callToolRaw(name, args);
        if (result.ok) {
          process.stdout.write(`${formatJson(result.data, pretty)}\n`);
        } else {
          process.stderr.write(`${formatJson({ error: result.error }, pretty)}\n`);
          process.exit(1);
        }
      } catch (err) {
        process.stderr.write(`  Error: ${errMsg(err)}\n`);
        process.exit(1);
      }
    },
  );
}
