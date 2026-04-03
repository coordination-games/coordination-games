import { Command } from "commander";
import { loadKey, exportKey, importKey } from "../keys.js";
import { loadConfig } from "../config.js";
import { ApiClient } from "../api-client.js";

export function registerWalletCommands(program: Command) {
  program
    .command("balance")
    .description("Show USDC balance and credit balance")
    .action(async () => {
      const wallet = loadKey();
      if (!wallet) {
        process.stdout.write(`\n  No identity found. Run 'coordination init' first.\n\n`);
        return;
      }

      const config = loadConfig();
      const client = new ApiClient(config.serverUrl);

      process.stdout.write(`\n  Address: ${wallet.address}\n`);

      // First get agentId from status, then get balance
      try {
        const status = await client.get(`/api/relay/status/${wallet.address}`);
        if (!status.registered || !status.agentId) {
          process.stdout.write(`  Status:  Not registered\n`);
          process.stdout.write(`\n  Register first: coordination register <name>\n`);
          process.stdout.write(`\n`);
          return;
        }

        const data = await client.get(`/api/relay/balance/${status.agentId}`);
        process.stdout.write(`  Agent ID: ${status.agentId}\n`);
        process.stdout.write(`  USDC:     ${data.usdc ?? "N/A"}\n`);
        process.stdout.write(`  Credits:  ${data.credits ?? "N/A"}\n`);
      } catch (err: any) {
        process.stdout.write(`  Server unreachable: ${err.message}\n`);
      }

      process.stdout.write(`\n`);
    });

  program
    .command("fund")
    .description("Show deposit address for funding your account")
    .action(async () => {
      const wallet = loadKey();
      if (!wallet) {
        process.stdout.write(`\n  No identity found. Run 'coordination init' first.\n\n`);
        return;
      }

      process.stdout.write(`\n  Deposit USDC (Optimism) to:\n`);
      process.stdout.write(`  ${wallet.address}\n\n`);
      process.stdout.write(`  Only send USDC on Optimism (chain ID 10).\n`);
      process.stdout.write(`  Other tokens or chains will be lost.\n\n`);
    });

  program
    .command("withdraw <amount>")
    .description("Request withdrawal of credits (two-step: request then execute after cooldown)")
    .option("--execute", "Execute a pending withdrawal (skip request step)")
    .action(async (amount: string, opts: any) => {
      const wallet = loadKey();
      if (!wallet) {
        process.stdout.write(`\n  No identity found. Run 'coordination init' first.\n\n`);
        return;
      }

      const config = loadConfig();
      const client = new ApiClient(config.serverUrl);

      try {
        // Get agent ID from status
        const status = await client.get(`/api/relay/status/${wallet.address}`);
        if (!status.registered || !status.agentId) {
          process.stdout.write(`\n  Not registered. Register first.\n\n`);
          return;
        }

        if (opts.execute) {
          // Execute a pending burn
          const result = await client.post("/api/relay/burn-execute", {
            agentId: status.agentId,
          });
          process.stdout.write(`\n  Withdrawal executed!\n`);
          process.stdout.write(`  Tx: ${result.txHash}\n`);
          process.stdout.write(`  Remaining credits: ${result.credits}\n`);
        } else {
          // Request a new burn
          const creditAmount = BigInt(Math.floor(parseFloat(amount) * 100_000_000));
          const result = await client.post("/api/relay/burn-request", {
            agentId: status.agentId,
            amount: creditAmount.toString(),
          });
          const executeAfter = new Date(Number(result.executeAfter) * 1000);
          process.stdout.write(`\n  Withdrawal requested: ${amount} USDC worth of credits\n`);
          process.stdout.write(`  Pending amount: ${result.pendingAmount} credits\n`);
          process.stdout.write(`  Executable after: ${executeAfter.toISOString()}\n`);
          process.stdout.write(`\n  Run 'coordination withdraw ${amount} --execute' after cooldown.\n`);
        }
      } catch (err: any) {
        process.stderr.write(`  Withdrawal failed: ${err.message}\n`);
        process.exit(1);
      }
      process.stdout.write(`\n`);
    });

  program
    .command("export-key")
    .description("Export key file to a path")
    .argument("[path]", "Destination path", "./coordination-key.json")
    .action(async (destPath: string) => {
      try {
        exportKey(destPath);
        process.stdout.write(`\n  Key exported to: ${destPath}\n\n`);
      } catch (err: any) {
        process.stderr.write(`  Error: ${err.message}\n`);
        process.exit(1);
      }
    });

  program
    .command("import-key <path>")
    .description("Import key file from a path")
    .action(async (srcPath: string) => {
      try {
        const wallet = importKey(srcPath);
        process.stdout.write(`\n  Key imported!\n`);
        process.stdout.write(`  Address: ${wallet.address}\n\n`);
      } catch (err: any) {
        process.stderr.write(`  Error: ${err.message}\n`);
        process.exit(1);
      }
    });
}
