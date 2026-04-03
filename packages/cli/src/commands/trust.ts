import { Command } from "commander";
import { loadKey } from "../keys.js";
import { loadConfig } from "../config.js";
import { ApiClient } from "../api-client.js";

/**
 * EAS TrustGraph attestation commands.
 *
 * Attestations are submitted via the server relay (POST /api/relay/attest)
 * which forwards to EAS on Optimism. The player signs the attestation data
 * locally with their private key; the relay submits the on-chain transaction.
 */

// EAS contract on Optimism
const EAS_ADDRESS = "0x4200000000000000000000000000000000000021";

// TrustGraph schema: (uint256 confidence, string context)
// This UID should be set after running register-eas-schema.ts
// For now, use a placeholder — the relay endpoint will use the configured UID
const SCHEMA_UID = "0x0000000000000000000000000000000000000000000000000000000000000000";

export function registerTrustCommands(program: Command) {
  // -----------------------------------------------------------------------
  // coordination attest <agentId> <confidence> [context]
  // -----------------------------------------------------------------------
  program
    .command("attest <agentId> <confidence> [context]")
    .description("Create a trust attestation for another agent (EAS on Optimism)")
    .action(async (agentId: string, confidenceStr: string, context?: string) => {
      const wallet = loadKey();
      if (!wallet) {
        process.stderr.write("  No identity found. Run 'coordination init' first.\n");
        process.exit(1);
      }

      const confidence = parseInt(confidenceStr, 10);
      if (isNaN(confidence) || confidence < 1 || confidence > 100) {
        process.stderr.write("  Error: confidence must be 1-100\n");
        process.exit(1);
      }

      const ctx = context || "";
      const config = loadConfig();
      const client = new ApiClient(config.serverUrl);

      try {
        // Sign the attestation data with EIP-712
        const { ethers } = await import("ethers");

        const domain = {
          name: "Coordination TrustGraph",
          version: "1",
          chainId: 10, // Optimism
        };

        const types = {
          Attestation: [
            { name: "recipient", type: "uint256" },
            { name: "confidence", type: "uint256" },
            { name: "context", type: "string" },
          ],
        };

        const message = {
          recipient: agentId,
          confidence,
          context: ctx,
        };

        const signature = await wallet.signTypedData(domain, types, message);

        // Submit via relay
        const result = await client.post("/api/relay/attest", {
          attester: wallet.address,
          recipient: agentId,
          confidence,
          context: ctx,
          signature,
          schemaUid: SCHEMA_UID,
        });

        process.stdout.write(`\n  Attestation created.\n`);
        if (result.attestationUid) {
          process.stdout.write(`  UID: ${result.attestationUid}\n`);
        }
        if (result.txHash) {
          process.stdout.write(`  Tx:  ${result.txHash}\n`);
        }
        process.stdout.write(`\n  Confidence: ${confidence}/100\n`);
        if (ctx) {
          process.stdout.write(`  Context:    ${ctx}\n`);
        }
        process.stdout.write(`\n`);
      } catch (err: any) {
        process.stderr.write(`  Error: ${err.message}\n`);
        process.exit(1);
      }
    });

  // -----------------------------------------------------------------------
  // coordination revoke <attestationId>
  // -----------------------------------------------------------------------
  program
    .command("revoke <attestationId>")
    .description("Revoke an existing trust attestation")
    .action(async (attestationId: string) => {
      const wallet = loadKey();
      if (!wallet) {
        process.stderr.write("  No identity found. Run 'coordination init' first.\n");
        process.exit(1);
      }

      const config = loadConfig();
      const client = new ApiClient(config.serverUrl);

      try {
        const { ethers } = await import("ethers");

        // Sign the revocation request
        const domain = {
          name: "Coordination TrustGraph",
          version: "1",
          chainId: 10,
        };

        const types = {
          Revocation: [
            { name: "attestationUid", type: "bytes32" },
          ],
        };

        const message = {
          attestationUid: attestationId,
        };

        const signature = await wallet.signTypedData(domain, types, message);

        const result = await client.post("/api/relay/revoke", {
          attester: wallet.address,
          attestationUid: attestationId,
          signature,
          schemaUid: SCHEMA_UID,
        });

        process.stdout.write(`\n  Attestation revoked.\n`);
        if (result.txHash) {
          process.stdout.write(`  Tx: ${result.txHash}\n`);
        }
        process.stdout.write(`\n`);
      } catch (err: any) {
        process.stderr.write(`  Error: ${err.message}\n`);
        process.exit(1);
      }
    });

  // -----------------------------------------------------------------------
  // coordination reputation <agentId>
  // -----------------------------------------------------------------------
  program
    .command("reputation <agentId>")
    .description("Query trust reputation for an agent")
    .action(async (agentId: string) => {
      const config = loadConfig();
      const client = new ApiClient(config.serverUrl);

      try {
        const data = await client.get(`/api/relay/reputation/${encodeURIComponent(agentId)}`);

        process.stdout.write(`\n  Reputation for agent ${agentId}\n`);
        process.stdout.write(`  ${"=".repeat(40)}\n\n`);

        process.stdout.write(`  Attestations: ${data.totalAttestations}\n`);
        process.stdout.write(`  Avg confidence: ${data.averageConfidence?.toFixed(1) ?? "N/A"}\n\n`);

        if (data.recentAttestors && data.recentAttestors.length > 0) {
          process.stdout.write(`  Recent attestors:\n`);
          for (const a of data.recentAttestors) {
            const conf = String(a.confidence).padStart(3, " ");
            const ctx = a.context ? ` — ${a.context}` : "";
            const time = a.time ? ` (${new Date(a.time * 1000).toLocaleDateString()})` : "";
            process.stdout.write(`    [${conf}] ${a.attester}${ctx}${time}\n`);
          }
        } else {
          process.stdout.write(`  No attestations found.\n`);
        }

        process.stdout.write(`\n`);
      } catch (err: any) {
        process.stderr.write(`  Error: ${err.message}\n`);
        process.exit(1);
      }
    });
}
