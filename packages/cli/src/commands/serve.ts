import { Command } from "commander";
import crypto from "node:crypto";

async function requestBotToken(serverUrl: string, name: string, secret?: string): Promise<string> {
  const response = await fetch(`${serverUrl}/api/player/auth/bot`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, ...(secret ? { secret } : {}) }),
  });

  const data = await response.json() as { token?: string; error?: string };
  if (!response.ok || !data.token) {
    throw new Error(data.error || `Bot auth failed with status ${response.status}`);
  }
  return data.token;
}

export function registerServeCommand(program: Command) {
  program
    .command("serve")
    .description("Start MCP server for AI tool integration")
    .option("--stdio", "Use stdio transport (for Claude Code, Claude Desktop)")
    .option("--http [port]", "Use HTTP transport (for OpenAI, other HTTP MCP clients)")
    .option("--bot-mode", undefined, false)  // hidden: internal testing
    .option("--key <key>", undefined)         // hidden: bot private key
    .option("--name <name>", undefined)       // hidden: bot display name
    .option("--bot-secret <secret>", undefined) // hidden: shared secret for non-local bot token auth
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
        const token = key ? undefined : await requestBotToken(serverUrl, name, opts.botSecret || process.env.COGA_BOT_SECRET);

        await startMcpServer(mode, {
          serverUrl,
          privateKey: key,
          token,
          name,
          botMode: true,
          httpPort,
        });
      } else {
        // Normal mode: use local wallet from ~/.coordination/keys/
        const { loadKey } = await import("../keys.js");
        const { loadConfig, loadSession, saveSession } = await import("../config.js");
        const { ApiClient } = await import("../api-client.js");
        const wallet = loadKey();
        const config = loadConfig();
        const serverUrl = opts.serverUrl || config.serverUrl;

        // Resolve registered name (check session cache, then server)
        let name: string | undefined;
        const session = loadSession();
        if (session.handle) {
          name = session.handle;
        } else if (wallet) {
          try {
            const api = new ApiClient(serverUrl);
            const data = await api.get(`/api/relay/status/${wallet.address}`);
            if (data.registered && data.name) {
              name = data.name;
              session.handle = data.name;
              saveSession(session);
            }
          } catch {}
        }

        await startMcpServer(mode, {
          serverUrl,
          privateKey: wallet?.privateKey,
          name,
          botMode: false,
          httpPort,
        });
      }
    });
}
