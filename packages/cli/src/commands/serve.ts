import { Command } from "commander";
import crypto from "node:crypto";

export function registerServeCommand(program: Command) {
  program
    .command("serve")
    .description("Start MCP server for AI tool integration")
    .option("--stdio", "Use stdio transport (for Claude Code, Claude Desktop)")
    .option("--http [port]", "Use HTTP transport (for OpenAI, other HTTP MCP clients)")
    .option("--bot-mode", undefined, false)  // hidden: internal testing
    .option("--key <key>", undefined)         // hidden: bot private key
    .option("--name <name>", undefined)       // hidden: bot display name
    .option("--server-url <url>", "Game server URL (default: from config)")
    .action(async (opts) => {
      // Dynamic import to avoid loading MCP deps when not needed
      const { startMcpServer } = await import("../mcp-server.js");

      const httpPort = typeof opts.http === "string" ? parseInt(opts.http, 10) : undefined;
      const mode: "stdio" | "http" = opts.http ? "http" : "stdio";

      if (opts.botMode) {
        // Bot mode: use provided key (or generate ephemeral one)
        const { loadConfig } = await import("../config.js");
        const serverUrl = opts.serverUrl || loadConfig().serverUrl;
        const key = opts.key || undefined;
        const name = opts.name || `bot-${crypto.randomBytes(3).toString('hex')}`;

        await startMcpServer(mode, {
          serverUrl,
          privateKey: key,
          name,
          botMode: true,
          httpPort,
        });
      } else {
        // Normal mode: use local wallet from ~/.coordination/keys/
        const { loadKey } = await import("../keys.js");
        const { loadConfig } = await import("../config.js");
        const wallet = loadKey();
        const config = loadConfig();

        await startMcpServer(mode, {
          serverUrl: opts.serverUrl || config.serverUrl,
          privateKey: wallet?.privateKey,
          name: undefined, // derived from wallet address during auth
          botMode: false,
          httpPort,
        });
      }
    });
}
