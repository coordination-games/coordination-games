import type { Command } from 'commander';
import { ApiClient } from '../api-client.js';
import { loadConfig, loadSession, saveSession } from '../config.js';
import { formatCreditsDisplay } from '../credits.js';
import { checkPermissions, loadKey } from '../keys.js';

export function registerStatusCommand(program: Command) {
  program
    .command('status')
    .description('Show address, registration status, agent ID, name, and credit balance')
    .action(async () => {
      const wallet = loadKey();
      if (!wallet) {
        process.stdout.write(`\n  No identity found. Run 'coordination init' first.\n\n`);
        return;
      }

      const perms = checkPermissions();
      if (perms.warning) {
        process.stderr.write(`  ${perms.warning}\n`);
      }

      const config = loadConfig();

      process.stdout.write(`\n  Address:  ${wallet.address}\n`);
      process.stdout.write(`  Server:   ${config.serverUrl}\n`);
      process.stdout.write(`  Key mode: ${config.keyMode}\n`);

      try {
        const client = new ApiClient(config.serverUrl);
        const data = await client.getRelayStatus(wallet.address);

        if (data.registered) {
          // Cache name in session for auth
          if (data.name) {
            const session = loadSession();
            if (session.handle !== data.name) {
              session.handle = data.name;
              saveSession(session);
            }
          }
          process.stdout.write(`  Agent ID: ${data.agentId}\n`);
          process.stdout.write(`  Name:     ${data.name}\n`);
          process.stdout.write(`  Credits:  ${formatCreditsDisplay(data.credits)}\n`);
        } else {
          process.stdout.write(`  Status:   Not registered\n`);
          process.stdout.write(`\n  Get started with: coordination check-name <your-name>\n`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stdout.write(`  Server:   Unreachable (${msg})\n`);
      }

      process.stdout.write(`\n`);
    });
}
