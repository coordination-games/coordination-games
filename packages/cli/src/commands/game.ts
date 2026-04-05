import { Command } from "commander";
import { loadConfig, loadSession, saveSession } from "../config.js";
import { ApiClient } from "../api-client.js";
import { GameClient } from "../game-client.js";
import { McpClient } from "../mcp-client.js";
import { processState, initPipeline } from "../pipeline.js";
import { formatChatMessage } from "@coordination-games/plugin-chat";
import { loadKey } from "../keys.js";

function getMcpClient(config: { serverUrl: string }): McpClient {
  return new McpClient(config.serverUrl);
}

function requireToken(): string {
  const session = loadSession();
  if (!session.token) {
    process.stderr.write(
      `\n  Not authenticated. Run 'coga init' to create a wallet first.\n\n`
    );
    process.exit(1);
  }
  return session.token;
}

export function registerGameCommands(program: Command) {
  // ==================== signin (wallet-based auth) ====================
  program
    .command("signin [handle]")
    .description("Authenticate with the game server using your local wallet")
    .action(async (handle?: string) => {
      const config = loadConfig();
      const wallet = loadKey();
      if (!wallet) {
        process.stderr.write(`\n  No wallet found. Run 'coga init' to create one.\n\n`);
        process.exit(1);
        return;
      }

      const name = handle || wallet.address.slice(0, 10);
      const client = new GameClient(config.serverUrl, {
        privateKey: wallet.privateKey,
        name,
      });

      try {
        await client.authenticate(wallet.privateKey);
        const token = client.getToken();
        process.stdout.write(`\n  Authenticated as "${name}"\n`);
        process.stdout.write(`  Address: ${wallet.address}\n`);
        process.stdout.write(`  Token: ${token}\n\n`);

        // Save to session for legacy CLI commands that use requireToken()
        const session = loadSession();
        session.token = token ?? undefined;
        session.handle = name;
        saveSession(session);
      } catch (err: any) {
        process.stderr.write(`  Error: ${err.message}\n`);
        process.exit(1);
      }
    });

  // ==================== lobbies ====================
  program
    .command("lobbies")
    .description("List available game lobbies")
    .action(async () => {
      const config = loadConfig();
      const client = new ApiClient(config.serverUrl);

      try {
        const lobbies = await client.get("/api/lobbies");

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
    .option("-s, --size <n>", "Team size (2-6)", "2")
    .action(async (opts) => {
      const config = loadConfig();
      const token = requireToken();
      const mcp = getMcpClient(config);

      const teamSize = Math.min(6, Math.max(2, parseInt(opts.size, 10) || 2));

      try {
        const result = await mcp.callTool("create_lobby", {
          token,
          teamSize,
        });

        if (result.error) {
          process.stderr.write(`  Error: ${result.error}\n`);
          process.exit(1);
        }

        const lobbyId = result.lobbyId;
        process.stdout.write(`\n  Lobby created: ${lobbyId}\n`);
        process.stdout.write(`  Team size: ${teamSize}v${teamSize}\n\n`);

        const session = loadSession();
        session.currentLobbyId = lobbyId;
        saveSession(session);
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
      const config = loadConfig();
      const token = requireToken();
      const mcp = getMcpClient(config);

      try {
        const result = await mcp.callTool("join_lobby", {
          token,
          lobbyId,
        });

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
      const config = loadConfig();
      const token = requireToken();
      const mcp = getMcpClient(config);

      try {
        const result = await mcp.callTool("get_guide", {
          token,
          ...(game ? { game } : {}),
        });

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
      const config = loadConfig();
      const token = requireToken();
      const mcp = getMcpClient(config);

      try {
        const rawResult = await mcp.callTool("get_state", { token });

        if (rawResult.error) {
          process.stderr.write(`  Error: ${rawResult.error}\n`);
          process.exit(1);
        }

        // Track game ID if present
        if (rawResult.gameId) {
          const session = loadSession();
          session.currentGameId = rawResult.gameId;
          saveSession(session);
        }

        // Run client-side pipeline over relay messages
        const processed = processState({
          gameState: rawResult,
          relayMessages: rawResult.relayMessages ?? [],
        });

        // Output: game state + pipeline-processed messages
        const output: any = { ...rawResult };
        delete output.relayMessages; // remove raw relay data
        if (processed.messages.length > 0) {
          output.messages = processed.messages;
        }

        process.stdout.write(JSON.stringify(output, null, 2) + "\n");
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
      const config = loadConfig();
      const token = requireToken();
      const mcp = getMcpClient(config);

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

        // If it's an array, treat as direction path (gameplay move)
        const toolArgs = Array.isArray(moveData)
          ? { token, path: moveData }
          : { token, ...moveData };

        const result = await mcp.callTool("submit_move", toolArgs);

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
      const config = loadConfig();
      const token = requireToken();
      const mcp = getMcpClient(config);

      try {
        process.stdout.write("  Waiting for update...\n");
        const rawResult = await mcp.callTool("wait_for_update", { token });

        if (rawResult.error) {
          process.stderr.write(`  Error: ${rawResult.error}\n`);
          process.exit(1);
        }

        // Track game ID if present
        if (rawResult.gameId) {
          const session = loadSession();
          session.currentGameId = rawResult.gameId;
          saveSession(session);
        }

        // Run pipeline over relay messages
        const processed = processState({
          gameState: rawResult,
          relayMessages: rawResult.relayMessages ?? [],
        });

        const output: any = { ...rawResult };
        delete output.relayMessages;
        if (processed.messages.length > 0) {
          output.messages = processed.messages;
        }

        process.stdout.write(JSON.stringify(output, null, 2) + "\n");
      } catch (err: any) {
        process.stderr.write(`  Error: ${err.message}\n`);
        process.exit(1);
      }
    });

  // ==================== chat ====================
  program
    .command("chat <message>")
    .description("Send a message (team chat during game, all chat in lobby)")
    .action(async (message: string) => {
      const config = loadConfig();
      const token = requireToken();
      const mcp = getMcpClient(config);

      try {
        // Use the chat plugin to format the relay message
        // For now, we send through the MCP chat tool (which pushes to relay)
        // TODO: Once fully relay-native, send directly to relay endpoint
        const result = await mcp.callTool("chat", { token, message });

        if (result.error) {
          process.stderr.write(`  Error: ${result.error}\n`);
          process.exit(1);
        }

        process.stdout.write(`  Message sent.\n`);
      } catch (err: any) {
        process.stderr.write(`  Error: ${err.message}\n`);
        process.exit(1);
      }
    });

  // ==================== tool ====================
  program
    .command("tool <name> [args...]")
    .description("Invoke a plugin tool (e.g. coga tool attest wolfpack7 85)")
    .action(async (name: string, args: string[]) => {
      const config = loadConfig();
      const token = requireToken();
      const mcp = getMcpClient(config);

      try {
        // Parse args as key=value pairs or positional args
        const toolArgs: Record<string, any> = { token };

        for (const arg of args) {
          if (arg.includes("=")) {
            const [key, ...rest] = arg.split("=");
            const value = rest.join("=");
            // Try to parse as JSON, fall back to string
            try {
              toolArgs[key] = JSON.parse(value);
            } catch {
              toolArgs[key] = value;
            }
          } else {
            // Positional args: store as _args array
            if (!toolArgs._args) toolArgs._args = [];
            toolArgs._args.push(arg);
          }
        }

        const result = await mcp.callTool(name, toolArgs);

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

  // ==================== session ====================
  program
    .command("session")
    .description("Show current session info")
    .action(async () => {
      const session = loadSession();

      process.stdout.write(`\n  Session State:\n`);
      process.stdout.write(
        `  Handle:    ${session.handle || "(not signed in)"}\n`
      );
      process.stdout.write(
        `  Agent ID:  ${session.agentId || "(none)"}\n`
      );
      process.stdout.write(
        `  Token:     ${session.token ? session.token.slice(0, 6) + "..." : "(none)"}\n`
      );
      process.stdout.write(
        `  Lobby:     ${session.currentLobbyId || "(none)"}\n`
      );
      process.stdout.write(
        `  Game:      ${session.currentGameId || "(none)"}\n`
      );
      process.stdout.write(`\n`);
    });
}
