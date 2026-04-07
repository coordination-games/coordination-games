import { Command } from "commander";
import { loadConfig, loadSession, saveSession } from "../config.js";
import { GameClient } from "../game-client.js";
import { ApiClient } from "../api-client.js";
import { loadKey } from "../keys.js";

/**
 * Resolve the player's registered name. Checks session cache first,
 * then fetches from the relay status endpoint and caches for next time.
 */
async function resolveName(wallet: { address: string; privateKey: string }, serverUrl: string): Promise<string> {
  const session = loadSession();
  if (session.handle) return session.handle;

  // Fetch name from server
  try {
    const api = new ApiClient(serverUrl);
    const data = await api.get(`/api/relay/status/${wallet.address}`);
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
 * All CLI commands use this instead of the old McpClient + requireToken() flow.
 */
async function createClient(): Promise<GameClient> {
  const config = loadConfig();
  const wallet = loadKey();
  if (!wallet) {
    process.stderr.write(
      `\n  No wallet found. Run 'coga init' to create one.\n\n`
    );
    process.exit(1);
  }

  const session = loadSession();
  const name = await resolveName(wallet, config.serverUrl);

  return new GameClient(config.serverUrl, {
    privateKey: wallet.privateKey,
    token: session.token,
    name,
  });
}

export function registerGameCommands(program: Command) {
  // ==================== lobbies ====================
  program
    .command("lobbies")
    .description("List available game lobbies")
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
          const agentCount = lobby.agents?.length ?? 0;
          const phase = lobby.phase ?? "forming";
          const externalCount = lobby.externalSlots?.length ?? 0;
          process.stdout.write(
            `  [${lobby.lobbyId}] phase: ${phase} — ${agentCount} agents, ${externalCount} external slots\n`
          );
          if (lobby.gameId) {
            process.stdout.write(`    -> Game started: ${lobby.gameId}\n`);
          }
        }
        process.stdout.write(`\n`);
      } catch (err: any) {
        process.stderr.write(`  Error: ${err.message}\n`);
        process.exit(1);
      }
    });

  // ==================== create-lobby ====================
  program
    .command("create-lobby")
    .description("Create a new game lobby")
    .option("-s, --size <n>", "Team size (2-6) for CtL, player count (4-20) for OATHBREAKER", "2")
    .option("-g, --game <name>", "Game type: capture-the-lobster or oathbreaker", "capture-the-lobster")
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

        if (gameType === 'oathbreaker') {
          process.stdout.write(`\n  OATHBREAKER game created: ${result.gameId}\n`);
          process.stdout.write(`  Players: ${result.playerCount}\n\n`);
          const session = loadSession();
          session.currentGameId = result.gameId;
          saveSession(session);
        } else {
          const lobbyId = result.lobbyId;
          const teamSize = Math.min(6, Math.max(2, size));
          process.stdout.write(`\n  Lobby created: ${lobbyId}\n`);
          process.stdout.write(`  Team size: ${teamSize}v${teamSize}\n\n`);
          const session = loadSession();
          session.currentLobbyId = lobbyId;
          saveSession(session);
        }
      } catch (err: any) {
        process.stderr.write(`  Error: ${err.message}\n`);
        process.exit(1);
      }
    });

  // ==================== join ====================
  program
    .command("join <lobbyId>")
    .description("Join a game lobby")
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
      } catch (err: any) {
        process.stderr.write(`  Error: ${err.message}\n`);
        process.exit(1);
      }
    });

  // ==================== guide ====================
  program
    .command("guide [game]")
    .description("Dynamic playbook — game rules, your plugins, available actions")
    .action(async (game?: string) => {
      const client = await createClient();

      try {
        const result = await client.getGuide(game);

        if (result.error) {
          process.stderr.write(`  Error: ${result.error}\n`);
          process.exit(1);
        }

        process.stdout.write(typeof result === "string" ? result : JSON.stringify(result, null, 2));
        process.stdout.write("\n");
      } catch (err: any) {
        process.stderr.write(`  Error: ${err.message}\n`);
        process.exit(1);
      }
    });

  // ==================== state ====================
  program
    .command("state")
    .description("Get current game/lobby state (processed through your plugin pipeline)")
    .action(async () => {
      const client = await createClient();

      try {
        const result = await client.getState();

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

        process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      } catch (err: any) {
        process.stderr.write(`  Error: ${err.message}\n`);
        process.exit(1);
      }
    });

  // ==================== move ====================
  program
    .command("move <data>")
    .description(
      'Submit an action for the current phase. During gameplay: \'["N","NE"]\' (directions). During lobby phases: \'{"action":"propose-team","target":"agent123"}\''
    )
    .action(async (dataStr: string) => {
      const client = await createClient();

      try {
        let moveData: any;
        try {
          moveData = JSON.parse(dataStr);
        } catch {
          process.stderr.write(
            `  Error: Invalid JSON. Examples:\n` +
            `    Gameplay:  coga move '["N","NE"]'\n` +
            `    Lobby:     coga move '{"action":"propose-team","target":"agent1"}'\n`
          );
          process.exit(1);
          return;
        }

        let result: any;
        if (Array.isArray(moveData)) {
          result = await client.submitMove(moveData);
        } else {
          result = await client.submitAction(moveData.action, moveData.target, moveData.class);
        }

        if (result.error) {
          process.stderr.write(`  Error: ${result.error}\n`);
          process.exit(1);
        }

        process.stdout.write(`\n  Action submitted.\n`);
        if (result.turn !== undefined) {
          process.stdout.write(`  Turn: ${result.turn}\n`);
        }
        process.stdout.write(`\n`);
      } catch (err: any) {
        process.stderr.write(`  Error: ${err.message}\n`);
        process.exit(1);
      }
    });

  // ==================== wait ====================
  program
    .command("wait")
    .description("Wait for the next game update (long-poll)")
    .action(async () => {
      const client = await createClient();

      try {
        process.stdout.write("  Waiting for update...\n");
        const result = await client.waitForUpdate();

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

        process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      } catch (err: any) {
        process.stderr.write(`  Error: ${err.message}\n`);
        process.exit(1);
      }
    });

  // ==================== tool ====================
  program
    .command("tool <pluginId> <toolName> [args...]")
    .description("Invoke a plugin tool (e.g. coga tool basic-chat chat 'hello')")
    .action(async (pluginId: string, toolName: string, args: string[]) => {
      const client = await createClient();

      try {
        // Parse args as key=value pairs or positional args
        const toolArgs: Record<string, any> = {};

        for (const arg of args) {
          if (arg.includes("=")) {
            const [key, ...rest] = arg.split("=");
            const value = rest.join("=");
            try {
              toolArgs[key] = JSON.parse(value);
            } catch {
              toolArgs[key] = value;
            }
          } else {
            if (!toolArgs._args) toolArgs._args = [];
            toolArgs._args.push(arg);
          }
        }

        const result = await client.callPluginTool(pluginId, toolName, toolArgs);

        if (result.error) {
          process.stderr.write(`  Error: ${result.error}\n`);
          process.exit(1);
        }

        process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      } catch (err: any) {
        process.stderr.write(`  Error: ${err.message}\n`);
        process.exit(1);
      }
    });

}
