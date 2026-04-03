import { Command } from "commander";
import { loadKey, getOrCreateKey } from "../keys.js";
import { loadConfig } from "../config.js";
import { ApiClient } from "../api-client.js";
import { signPermit } from "../signing.js";
import * as readline from "node:readline";

const USDC_ADDRESS_OPTIMISM = "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85";
const REGISTRATION_COST_USDC = 5_000_000n; // 5 USDC (6 decimals)

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export function registerNameCommands(program: Command) {
  program
    .command("check-name <name>")
    .description("Check if a name is available for registration")
    .action(async (name: string) => {
      const config = loadConfig();
      const client = new ApiClient(config.serverUrl);

      try {
        const data = await client.get(`/api/relay/check-name/${encodeURIComponent(name)}`);
        if (data.available) {
          process.stdout.write(`\n  "${name}" is available!\n\n`);
        } else {
          process.stdout.write(`\n  "${name}" is taken.\n`);
          if (data.suggestions?.length) {
            process.stdout.write(`  Suggestions: ${data.suggestions.join(", ")}\n`);
          }
          process.stdout.write(`\n`);
        }
      } catch (err: any) {
        process.stderr.write(`  Error: ${err.message}\n`);
        process.exit(1);
      }
    });

  program
    .command("register <name>")
    .description("Register a name (costs 5 USDC)")
    .action(async (name: string) => {
      const wallet = loadKey();
      if (!wallet) {
        process.stdout.write(`\n  No identity found. Run 'coordination init' first.\n\n`);
        return;
      }

      const config = loadConfig();
      const client = new ApiClient(config.serverUrl);

      // Check availability first
      try {
        const check = await client.get(`/api/relay/check-name/${encodeURIComponent(name)}`);
        if (!check.available) {
          process.stdout.write(`\n  "${name}" is not available.\n\n`);
          return;
        }
      } catch (err: any) {
        process.stderr.write(`  Error checking name: ${err.message}\n`);
        process.exit(1);
      }

      // Confirm with user
      const answer = await prompt(`\n  Registration costs $5 USDC. Proceed? [y/N] `);
      if (answer.toLowerCase() !== "y") {
        process.stdout.write(`  Cancelled.\n\n`);
        return;
      }

      try {
        // Sign USDC permit for registration cost
        const deadline = Math.floor(Date.now() / 1000) + 3600; // 1 hour

        // Get server's registry address for permit signing
        let registryAddress = USDC_ADDRESS_OPTIMISM; // fallback
        try {
          const serverStatus = await client.get("/api/relay/check-name/_probe");
          // If server is up, the permit target should be the registry contract
          // For local dev, permits are mocked — deadline/v/r/s are ignored
        } catch {}

        const permitSig = await signPermit(
          wallet,
          USDC_ADDRESS_OPTIMISM,
          registryAddress,
          REGISTRATION_COST_USDC,
          deadline
        );

        const result = await client.post("/api/relay/register", {
          name,
          agentURI: `https://coordination.games/agent/${wallet.address}`,
          permitDeadline: deadline,
          v: permitSig.v,
          r: permitSig.r,
          s: permitSig.s,
        });

        process.stdout.write(`\n  Registered!\n`);
        process.stdout.write(`  Name:     ${result.name}\n`);
        process.stdout.write(`  Agent ID: ${result.agentId}\n`);
        process.stdout.write(`  Credits:  ${result.credits}\n\n`);
      } catch (err: any) {
        process.stderr.write(`  Registration failed: ${err.message}\n`);
        process.exit(1);
      }
    });
}
