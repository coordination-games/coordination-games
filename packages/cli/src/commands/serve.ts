import crypto from 'node:crypto';
import type { Command } from 'commander';

export function registerServeCommand(program: Command) {
  program
    .command('serve')
    .description('Start MCP server for AI tool integration')
    .option('--stdio', 'Use stdio transport (for Claude Code, Claude Desktop)')
    .option('--http [port]', 'Use HTTP transport (for OpenAI, other HTTP MCP clients)')
    .option('--bot-mode', undefined, false) // hidden: internal testing
    .option('--key <key>', undefined) // hidden: bot private key
    .option('--name <name>', undefined) // hidden: bot display name
    .option('--server-url <url>', 'Game server URL (default: from config)')
    .action(async (opts) => {
      // Dynamic import to avoid loading MCP deps when not needed
      const { startMcpServer } = await import('../mcp-server.js');

      const httpPort = typeof opts.http === 'string' ? parseInt(opts.http, 10) : undefined;
      const mode: 'stdio' | 'http' = opts.http ? 'http' : 'stdio';

      if (opts.botMode) {
        // Bot mode: use provided key (or generate ephemeral one)
        const { loadConfig } = await import('../config.js');
        const serverUrl = opts.serverUrl || loadConfig().serverUrl;
        const key = opts.key || undefined;
        const name = opts.name || `bot-${crypto.randomBytes(3).toString('hex')}`;

        // @ts-expect-error TS2379: Argument of type '{ serverUrl: any; privateKey: any; name: any; httpPort: number — TODO(2.3-followup)
        await startMcpServer(mode, {
          serverUrl,
          privateKey: key,
          name,
          httpPort,
        });
      } else {
        // Normal mode: use local wallet from ~/.coordination/keys/
        const { loadKey } = await import('../keys.js');
        const { loadConfig, loadSession, saveSession } = await import('../config.js');
        const { ApiClient } = await import('../api-client.js');
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
            const data = await api.getRelayStatus(wallet.address);
            if (data.registered && data.name) {
              name = data.name;
              session.handle = data.name;
              saveSession(session);
            }
          } catch {}
        }

        // @ts-expect-error TS2379: Argument of type '{ serverUrl: any; privateKey: string | undefined; name: string — TODO(2.3-followup)
        await startMcpServer(mode, {
          serverUrl,
          privateKey: wallet?.privateKey,
          name,
          httpPort,
        });
      }
    });
}
