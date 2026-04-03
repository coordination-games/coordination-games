import { Command } from "commander";
import { loadKey } from "../keys.js";
import { loadConfig } from "../config.js";
import { ApiClient } from "../api-client.js";
import { signMove } from "../signing.js";

export function registerGameCommands(program: Command) {
  program
    .command("lobbies")
    .description("List available game lobbies")
    .action(async () => {
      const config = loadConfig();
      const client = new ApiClient(config.serverUrl);

      try {
        const data = await client.get("/api/lobbies");
        const lobbies = data.lobbies || [];

        if (lobbies.length === 0) {
          process.stdout.write(`\n  No active lobbies.\n\n`);
          return;
        }

        process.stdout.write(`\n  Active Lobbies:\n`);
        for (const lobby of lobbies) {
          process.stdout.write(`  [${lobby.id}] ${lobby.gameType} — ${lobby.players}/${lobby.maxPlayers} players\n`);
        }
        process.stdout.write(`\n`);
      } catch (err: any) {
        process.stderr.write(`  Error: ${err.message}\n`);
        process.exit(1);
      }
    });

  program
    .command("join <lobbyId>")
    .description("Join a game lobby")
    .action(async (lobbyId: string) => {
      const wallet = loadKey();
      if (!wallet) {
        process.stdout.write(`\n  No identity found. Run 'coordination init' first.\n\n`);
        return;
      }

      const config = loadConfig();
      const client = new ApiClient(config.serverUrl);

      try {
        const result = await client.post("/api/lobbies/join", {
          lobbyId,
          address: wallet.address,
        });
        process.stdout.write(`\n  Joined lobby ${lobbyId}\n`);
        if (result.gameId) {
          process.stdout.write(`  Game starting: ${result.gameId}\n`);
        }
      } catch (err: any) {
        process.stderr.write(`  Error: ${err.message}\n`);
        process.exit(1);
      }
      process.stdout.write(`\n`);
    });

  program
    .command("state")
    .description("Get current game state")
    .action(async () => {
      const wallet = loadKey();
      if (!wallet) {
        process.stdout.write(`\n  No identity found. Run 'coordination init' first.\n\n`);
        return;
      }

      const config = loadConfig();
      const client = new ApiClient(config.serverUrl);

      try {
        const data = await client.get(`/api/game/state?address=${wallet.address}`);
        process.stdout.write(JSON.stringify(data, null, 2) + "\n");
      } catch (err: any) {
        process.stderr.write(`  Error: ${err.message}\n`);
        process.exit(1);
      }
    });

  program
    .command("move <data>")
    .description("Submit a signed game move (JSON data)")
    .action(async (data: string) => {
      const wallet = loadKey();
      if (!wallet) {
        process.stdout.write(`\n  No identity found. Run 'coordination init' first.\n\n`);
        return;
      }

      const config = loadConfig();
      const client = new ApiClient(config.serverUrl);

      try {
        const moveData = JSON.parse(data);

        // Get current game context for signing
        const gameState = await client.get(`/api/game/state?address=${wallet.address}`);
        const gameId = gameState.gameId;
        const turnNumber = gameState.turnNumber;
        const moveSchema = gameState.moveSchema || {
          Move: [
            { name: "gameId", type: "bytes32" },
            { name: "turnNumber", type: "uint16" },
            { name: "data", type: "string" },
          ],
        };

        const sig = await signMove(wallet, gameId, turnNumber, moveData, moveSchema);

        const result = await client.post("/api/game/move", {
          address: wallet.address,
          gameId,
          turnNumber,
          moveData,
          signature: sig.signature,
        });

        process.stdout.write(`\n  Move submitted.\n`);
        if (result.accepted) {
          process.stdout.write(`  Status: Accepted\n`);
        }
      } catch (err: any) {
        process.stderr.write(`  Error: ${err.message}\n`);
        process.exit(1);
      }
      process.stdout.write(`\n`);
    });

  program
    .command("wait")
    .description("Wait for the next game update")
    .action(async () => {
      const wallet = loadKey();
      if (!wallet) {
        process.stdout.write(`\n  No identity found. Run 'coordination init' first.\n\n`);
        return;
      }

      const config = loadConfig();
      const client = new ApiClient(config.serverUrl);

      try {
        const data = await client.get(`/api/game/wait?address=${wallet.address}`);
        process.stdout.write(JSON.stringify(data, null, 2) + "\n");
      } catch (err: any) {
        process.stderr.write(`  Error: ${err.message}\n`);
        process.exit(1);
      }
    });

  program
    .command("chat <message>")
    .description("Send a message to your team chat")
    .action(async (message: string) => {
      const wallet = loadKey();
      if (!wallet) {
        process.stdout.write(`\n  No identity found. Run 'coordination init' first.\n\n`);
        return;
      }

      const config = loadConfig();
      const client = new ApiClient(config.serverUrl);

      try {
        await client.post("/api/game/chat", {
          address: wallet.address,
          message,
        });
        process.stdout.write(`\n  Message sent.\n\n`);
      } catch (err: any) {
        process.stderr.write(`  Error: ${err.message}\n`);
        process.exit(1);
      }
    });
}
