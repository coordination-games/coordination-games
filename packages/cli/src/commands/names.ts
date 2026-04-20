import type { Command } from 'commander';
import { ApiClient } from '../api-client.js';
import { loadConfig, loadSession, saveSession } from '../config.js';
import { formatCreditsDisplay } from '../credits.js';
import { loadKey } from '../keys.js';
import { signPermit } from '../signing.js';

const USDC_ADDRESS_OPTIMISM = '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85';
const REGISTRATION_COST_USDC = 5_000_000n; // 5 USDC (6 decimals)

export function registerNameCommands(program: Command) {
  program
    .command('check-name <name>')
    .description('Check if a name is available for registration')
    .action(async (name: string) => {
      const config = loadConfig();
      const client = new ApiClient(config.serverUrl);

      try {
        const data = await client.checkName(name);
        if (data.available) {
          const wallet = loadKey();
          const addr = wallet?.address ?? 'YOUR_AGENT_ADDRESS';
          const expires = Math.floor(Date.now() / 1000) + 3600;
          const regUrl = `${config.serverUrl}/register?name=${encodeURIComponent(name)}&addr=${addr}&expires=${expires}`;

          process.stdout.write(`\n  "${name}" is available!\n\n`);
          process.stdout.write(`  Registration page:\n  ${regUrl}\n\n`);
          process.stdout.write(`  Or register directly: coga register ${name}\n\n`);
        } else {
          process.stdout.write(`\n  "${name}" is taken.\n`);
          if (data.suggestions?.length) {
            process.stdout.write(`  Suggestions: ${data.suggestions.join(', ')}\n`);
          }
          process.stdout.write(`\n`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`  Error: ${msg}\n`);
        process.exit(1);
      }
    });

  program
    .command('register <name>')
    .description('Register a name (costs 5 USDC)')
    .option('-y, --yes', 'Skip confirmation prompt')
    .action(async (name: string, opts: { yes?: boolean }) => {
      const wallet = loadKey();
      if (!wallet) {
        process.stdout.write(`\n  No identity found. Run 'coga init' first.\n\n`);
        return;
      }

      const config = loadConfig();
      const client = new ApiClient(config.serverUrl);

      // Check availability first
      try {
        const check = await client.checkName(name);
        if (!check.available) {
          process.stdout.write(`\n  "${name}" is not available.\n\n`);
          return;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`  Error checking name: ${msg}\n`);
        process.exit(1);
      }

      // Skip confirmation if --yes flag is set (for agent use)
      if (!opts.yes) {
        // In non-interactive mode (piped stdin), just proceed
        const isTTY = process.stdin.isTTY;
        if (isTTY) {
          const readline = await import('node:readline');
          const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
          const answer = await new Promise<string>((resolve) => {
            rl.question(`\n  Registration costs $5 USDC. Proceed? [y/N] `, (a) => {
              rl.close();
              resolve(a.trim());
            });
          });
          if (answer.toLowerCase() !== 'y') {
            process.stdout.write(`  Cancelled.\n\n`);
            return;
          }
        }
        // If not TTY (piped), proceed without asking
      }

      try {
        const deadline = Math.floor(Date.now() / 1000) + 3600; // 1 hour

        const permitSig = await signPermit(
          wallet,
          USDC_ADDRESS_OPTIMISM,
          USDC_ADDRESS_OPTIMISM, // permit spender — will be overridden by server
          REGISTRATION_COST_USDC,
          deadline,
        );

        const result = await client.registerName({
          name,
          address: wallet.address,
          agentURI: `https://coordination.games/agent/${wallet.address}`,
          permitDeadline: deadline,
          v: permitSig.v,
          r: permitSig.r,
          s: permitSig.s,
        });

        // Save handle to session so auth uses the registered name
        const session = loadSession();
        session.handle = result.name || name;
        saveSession(session);

        process.stdout.write(`\n  Registered!\n`);
        process.stdout.write(`  Name:     ${result.name}\n`);
        process.stdout.write(`  Agent ID: ${result.agentId}\n`);
        process.stdout.write(`  Credits:  ${formatCreditsDisplay(result.credits)}\n\n`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`  Registration failed: ${msg}\n`);
        process.exit(1);
      }
    });
}
