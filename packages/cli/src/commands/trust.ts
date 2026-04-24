import type { Command } from 'commander';

/**
 * Trust commands — NOT YET IMPLEMENTED as plugin tools.
 *
 * These will be migrated to the trust-graph ToolPlugin.
 * See docs/TRUST_PLUGINS_SPEC.md for the full plan.
 *
 * When implemented, agents will use:
 *   coga tool trust-graph attest <agent> <confidence> [context]
 *   coga tool trust-graph revoke <attestationId>
 *   coga tool trust-graph reputation <agent>
 *
 * Or via MCP tools (attest, revoke, reputation) mid-game.
 */

export function registerTrustCommands(program: Command) {
  program
    .command('attest')
    .description(
      'Create a trust attestation (not yet implemented — see docs/TRUST_PLUGINS_SPEC.md)',
    )
    .action(() => {
      process.stderr.write('\n  Not yet implemented. See docs/TRUST_PLUGINS_SPEC.md\n\n');
      process.exit(1);
    });

  program
    .command('revoke')
    .description(
      'Revoke a trust attestation (not yet implemented — see docs/TRUST_PLUGINS_SPEC.md)',
    )
    .action(() => {
      process.stderr.write('\n  Not yet implemented. See docs/TRUST_PLUGINS_SPEC.md\n\n');
      process.exit(1);
    });

  program
    .command('reputation')
    .description('Query agent reputation (not yet implemented — see docs/TRUST_PLUGINS_SPEC.md)')
    .action(() => {
      process.stderr.write('\n  Not yet implemented. See docs/TRUST_PLUGINS_SPEC.md\n\n');
      process.exit(1);
    });
}
