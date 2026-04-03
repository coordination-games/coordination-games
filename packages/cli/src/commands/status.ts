import { Command } from "commander";
import { loadKey, checkPermissions } from "../keys.js";
import { loadConfig } from "../config.js";
import { ApiClient } from "../api-client.js";

export function registerStatusCommand(program: Command) {
  program
    .command("status")
    .description("Show address, registration status, agent ID, name, and credit balance")
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
        const data = await client.get(`/api/relay/status/${wallet.address}`);

        if (data.registered) {
          process.stdout.write(`  Agent ID: ${data.agentId}\n`);
          process.stdout.write(`  Name:     ${data.name}\n`);
          process.stdout.write(`  Credits:  ${data.credits}\n`);
        } else {
          process.stdout.write(`  Status:   Not registered\n`);
          process.stdout.write(`\n  Register with: coordination register <name>\n`);
        }
      } catch (err: any) {
        process.stdout.write(`  Server:   Unreachable (${err.message})\n`);
      }

      process.stdout.write(`\n`);
    });
}
