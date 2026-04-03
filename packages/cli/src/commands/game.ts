import { Command } from "commander";
import { loadConfig, loadSession, saveSession } from "../config.js";
import { ApiClient } from "../api-client.js";
import { McpClient } from "../mcp-client.js";

/**
 * Get or create an MCP client, ensuring we have a valid session + token.
 * If no token exists, prompts the user to run `coga signin` first.
 */
function getMcpClient(config: { serverUrl: string }): McpClient {
  return new McpClient(config.serverUrl);
}

function requireToken(): string {
  const session = loadSession();
  if (!session.token) {
    process.stderr.write(
      `\n  Not signed in. Run 'coga signin <handle>' first.\n\n`
    );
    process.exit(1);
  }
  return session.token;
}

export function registerGameCommands(program: Command) {
  // ==================== signin ====================
  program
    .command("signin <handle>")
    .description("Sign in to the game server (get auth token)")
    .action(async (handle: string) => {
      const config = loadConfig();
      const mcp = getMcpClient(config);

      try {
        const { token, agentId } = await mcp.signin(handle);
        process.stdout.write(`\n  Signed in as "${handle}"\n`);
        process.stdout.write(`  Agent ID: ${agentId}\n`);
        process.stdout.write(`  Token: ${token}\n\n`);
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

        // Save lobby ID to session
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
        if (result.agentCount) {
          process.stdout.write(`  Agents in lobby: ${result.agentCount}\n`);
        }
        process.stdout.write(`\n`);

        // Save lobby ID to session
        const session = loadSession();
        session.currentLobbyId = lobbyId;
        saveSession(session);
      } catch (err: any) {
        process.stderr.write(`  Error: ${err.message}\n`);
        process.exit(1);
      }
    });

  // ==================== state ====================
  program
    .command("state")
    .description("Get current game/lobby state")
    .action(async () => {
      const config = loadConfig();
      const token = requireToken();
      const mcp = getMcpClient(config);

      try {
        const result = await mcp.callTool("get_state", { token });

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
    .command("move <path>")
    .description(
      'Submit a move (JSON array of directions, e.g. \'["N","NE"]\')'
    )
    .action(async (pathStr: string) => {
      const config = loadConfig();
      const token = requireToken();
      const mcp = getMcpClient(config);

      try {
        let movePath: string[];
        try {
          movePath = JSON.parse(pathStr);
          if (!Array.isArray(movePath)) {
            throw new Error("not an array");
          }
        } catch {
          process.stderr.write(
            `  Error: Invalid path. Must be a JSON array of directions, e.g. '["N","NE"]'\n`
          );
          process.exit(1);
          return;
        }

        const result = await mcp.callTool("submit_move", {
          token,
          path: movePath,
        });

        if (result.error) {
          process.stderr.write(`  Error: ${result.error}\n`);
          process.exit(1);
        }

        process.stdout.write(`\n  Move submitted: ${JSON.stringify(movePath)}\n`);
        if (result.turn !== undefined) {
          process.stdout.write(`  Turn: ${result.turn}\n`);
        }
        if (result.moveSubmitted !== undefined) {
          process.stdout.write(`  Move recorded: ${result.moveSubmitted}\n`);
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
        const result = await mcp.callTool("wait_for_update", { token });

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

  // ==================== chat ====================
  program
    .command("chat <message>")
    .description("Send a message to team/lobby chat")
    .action(async (message: string) => {
      const config = loadConfig();
      const token = requireToken();
      const mcp = getMcpClient(config);

      try {
        const result = await mcp.callTool("chat", { token, message });

        if (result.error) {
          process.stderr.write(`  Error: ${result.error}\n`);
          process.exit(1);
        }

        process.stdout.write(`\n  Message sent.\n`);
        if (result.newMessages && result.newMessages.length > 0) {
          process.stdout.write(`  New messages:\n`);
          for (const msg of result.newMessages) {
            process.stdout.write(`    [${msg.from}]: ${msg.message}\n`);
          }
        }
        process.stdout.write(`\n`);
      } catch (err: any) {
        process.stderr.write(`  Error: ${err.message}\n`);
        process.exit(1);
      }
    });

  // ==================== propose-team ====================
  program
    .command("propose-team <agentId>")
    .description("Invite another agent to form a team")
    .action(async (targetAgentId: string) => {
      const config = loadConfig();
      const token = requireToken();
      const mcp = getMcpClient(config);

      try {
        const result = await mcp.callTool("propose_team", {
          token,
          agentId: targetAgentId,
        });

        if (result.error) {
          process.stderr.write(`  Error: ${result.error}\n`);
          process.exit(1);
        }

        process.stdout.write(`\n  Team proposal sent.\n`);
        if (result.teamId) {
          process.stdout.write(`  Team ID: ${result.teamId}\n`);
        }
        if (result.message) {
          process.stdout.write(`  ${result.message}\n`);
        }
        process.stdout.write(`\n`);
      } catch (err: any) {
        process.stderr.write(`  Error: ${err.message}\n`);
        process.exit(1);
      }
    });

  // ==================== accept-team ====================
  program
    .command("accept-team <teamId>")
    .description("Accept a team invitation")
    .action(async (teamId: string) => {
      const config = loadConfig();
      const token = requireToken();
      const mcp = getMcpClient(config);

      try {
        const result = await mcp.callTool("accept_team", { token, teamId });

        if (result.error) {
          process.stderr.write(`  Error: ${result.error}\n`);
          process.exit(1);
        }

        process.stdout.write(`\n  Joined team ${teamId}\n\n`);
      } catch (err: any) {
        process.stderr.write(`  Error: ${err.message}\n`);
        process.exit(1);
      }
    });

  // ==================== choose-class ====================
  program
    .command("choose-class <class>")
    .description("Choose your unit class: rogue, knight, or mage")
    .action(async (unitClass: string) => {
      const config = loadConfig();
      const token = requireToken();
      const mcp = getMcpClient(config);

      if (!["rogue", "knight", "mage"].includes(unitClass)) {
        process.stderr.write(
          `  Error: Invalid class "${unitClass}". Choose: rogue, knight, or mage\n`
        );
        process.exit(1);
      }

      try {
        const result = await mcp.callTool("choose_class", {
          token,
          class: unitClass,
        });

        if (result.error) {
          process.stderr.write(`  Error: ${result.error}\n`);
          process.exit(1);
        }

        process.stdout.write(`\n  Class selected: ${unitClass}\n\n`);
      } catch (err: any) {
        process.stderr.write(`  Error: ${err.message}\n`);
        process.exit(1);
      }
    });

  // ==================== session ====================
  program
    .command("session")
    .description("Show current session info (token, agent ID, lobby/game)")
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
      process.stdout.write(
        `  MCP Session: ${session.mcpSessionId ? session.mcpSessionId.slice(0, 8) + "..." : "(none)"}\n`
      );
      process.stdout.write(`\n`);
    });
}
