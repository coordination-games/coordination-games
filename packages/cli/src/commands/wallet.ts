import type { Command } from 'commander';
import { ApiClient } from '../api-client.js';
import { loadConfig } from '../config.js';
import { formatCreditsDisplay, parseCreditsInput } from '../credits.js';
import { exportKey, importKey, loadKey } from '../keys.js';

export function registerWalletCommands(program: Command) {
  program
    .command('balance')
    .description('Show USDC balance and credit balance')
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
        const status = await client.getRelayStatus(wallet.address);
        if (!status.registered || !status.agentId) {
          process.stdout.write(`  Status:  Not registered\n`);
          process.stdout.write(`\n  Register first: coordination register <name>\n`);
          process.stdout.write(`\n`);
          return;
        }

        const data = await client.getBalance(status.agentId);
        process.stdout.write(`  Agent ID: ${status.agentId}\n`);
        // USDC is returned in raw 6-decimal units. Credits are also
        // raw 6-decimal units on-chain; format both as whole-unit displays.
        process.stdout.write(`  USDC:     ${formatCreditsDisplay(data.usdc)}\n`);
        process.stdout.write(`  Credits:  ${formatCreditsDisplay(data.credits)}\n`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stdout.write(`  Server unreachable: ${msg}\n`);
      }

      process.stdout.write(`\n`);
    });

  program
    .command('fund')
    .description('Show deposit address for funding your account')
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
    .command('withdraw <amount>')
    .description(
      'Request withdrawal of <amount> whole credits (two-step: request then execute after cooldown)',
    )
    .option('--execute', 'Execute a pending withdrawal (skip request step)')
    .action(async (amount: string, opts: { execute?: boolean }) => {
      const wallet = loadKey();
      if (!wallet) {
        process.stdout.write(`\n  No identity found. Run 'coordination init' first.\n\n`);
        return;
      }

      const config = loadConfig();
      const client = new ApiClient(config.serverUrl);

      try {
        // Get agent ID from status
        const status = await client.getRelayStatus(wallet.address);
        if (!status.registered || !status.agentId) {
          process.stdout.write(`\n  Not registered. Register first.\n\n`);
          return;
        }

        if (opts.execute) {
          // Execute a pending burn
          const result = await client.burnExecute({ agentId: status.agentId });
          process.stdout.write(`\n  Withdrawal executed!\n`);
          process.stdout.write(`  Tx: ${result.txHash}\n`);
          process.stdout.write(`  Remaining credits: ${formatCreditsDisplay(result.credits)}\n`);
        } else {
          // `amount` is a user-facing whole-credit value. Scale to raw
          // 6-decimal on-chain units before hitting the contract.
          const rawAmount = parseCreditsInput(amount);
          const result = await client.burnRequest({
            agentId: status.agentId,
            amount: rawAmount.toString(),
          });
          const executeAfter = new Date(Number(result.executeAfter) * 1000);
          process.stdout.write(`\n  Withdrawal requested: ${amount} credits\n`);
          process.stdout.write(
            `  Pending amount: ${formatCreditsDisplay(result.pendingAmount)} credits\n`,
          );
          process.stdout.write(`  Executable after: ${executeAfter.toISOString()}\n`);
          process.stdout.write(
            `\n  Run 'coordination withdraw ${amount} --execute' after cooldown.\n`,
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`  Withdrawal failed: ${msg}\n`);
        process.exit(1);
      }
      process.stdout.write(`\n`);
    });

  program
    .command('export-key [path]')
    .description('Export key file to a path (default: ./coordination-key.json)')
    .action(async (destPath: string = './coordination-key.json') => {
      try {
        exportKey(destPath);
        process.stdout.write(`\n  Key exported to: ${destPath}\n\n`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`  Error: ${msg}\n`);
        process.exit(1);
      }
    });

  program
    .command('import-key <path>')
    .description('Import key file from a path')
    .action(async (srcPath: string) => {
      try {
        const wallet = importKey(srcPath);
        process.stdout.write(`\n  Key imported!\n`);
        process.stdout.write(`  Address: ${wallet.address}\n\n`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`  Error: ${msg}\n`);
        process.exit(1);
      }
    });
}
