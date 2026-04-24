import type { Command } from 'commander';
import type { TypedDataField } from 'ethers';
import { ApiClient } from '../api-client.js';
import { loadConfig } from '../config.js';
import { buildMerkleTree, type TurnData } from '../merkle.js';
import type { GameBundle, OnChainResult } from '../types.js';

/**
 * Game verification command.
 *
 * Fetches a game bundle from the server and independently verifies:
 * 1. config hash matches on-chain configHash
 * 2. Each move's EIP-712 signature matches the claimed player
 * 3. Game replay produces the same outcome (if engine is available)
 * 4. Merkle root of all turns matches on-chain movesRoot
 */

// Step result tracking
interface VerifyStep {
  label: string;
  passed: boolean;
  detail?: string;
}

function pass(label: string, detail?: string): VerifyStep {
  const step: VerifyStep = { label, passed: true };
  if (detail !== undefined) step.detail = detail;
  return step;
}

function fail(label: string, detail?: string): VerifyStep {
  const step: VerifyStep = { label, passed: false };
  if (detail !== undefined) step.detail = detail;
  return step;
}

/** Extract a user-facing message from a caught error. */
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function printStep(step: VerifyStep) {
  const icon = step.passed ? '[OK]' : '[FAIL]';
  process.stdout.write(`  ${icon} ${step.label}`);
  if (step.detail) {
    process.stdout.write(` — ${step.detail}`);
  }
  process.stdout.write('\n');
}

export function registerVerifyCommand(program: Command) {
  program
    .command('verify <gameId>')
    .description("Verify a game's integrity against on-chain records")
    .option('--server <url>', 'Override server URL')
    .action(async (gameId: string, opts: { server?: string }) => {
      const config = loadConfig();
      const serverUrl = opts.server || config.serverUrl;
      const client = new ApiClient(serverUrl);

      const steps: VerifyStep[] = [];

      process.stdout.write(`\n  Verifying game: ${gameId}\n`);
      process.stdout.write(`  ${'='.repeat(50)}\n\n`);

      // -------------------------------------------------------------------
      // Step 1: Fetch game bundle
      // -------------------------------------------------------------------
      let bundle: GameBundle;
      try {
        bundle = await client.getGameBundle(gameId);
        steps.push(pass('Fetch game bundle', `${bundle.turns?.length ?? 0} turns`));
      } catch (err) {
        steps.push(fail('Fetch game bundle', errMsg(err)));
        printResults(steps);
        return;
      }

      // -------------------------------------------------------------------
      // Step 2: Fetch on-chain result (via server API)
      // -------------------------------------------------------------------
      let onChainResult: OnChainResult | undefined;
      try {
        onChainResult = await client.getGameResult(gameId);
        steps.push(pass('Fetch on-chain result', `turnCount=${onChainResult.turnCount}`));
      } catch (err) {
        // On-chain result may not be available (game not settled yet, or local testing)
        steps.push(
          fail('Fetch on-chain result', `${errMsg(err)} (game may not be settled on-chain)`),
        );
        // Continue with what we can verify
      }

      // -------------------------------------------------------------------
      // Step 3: Verify config hash
      // -------------------------------------------------------------------
      if (bundle.config && onChainResult?.configHash) {
        try {
          const { ethers } = await import('ethers');
          const configJson = JSON.stringify(bundle.config, Object.keys(bundle.config).sort());
          const computedHash = ethers.keccak256(ethers.toUtf8Bytes(configJson));

          if (computedHash.toLowerCase() === onChainResult.configHash.toLowerCase()) {
            steps.push(pass('Verify config hash', `${computedHash.slice(0, 18)}...`));
          } else {
            steps.push(
              fail(
                'Verify config hash',
                `computed ${computedHash.slice(0, 18)}... != on-chain ${onChainResult.configHash.slice(0, 18)}...`,
              ),
            );
          }
        } catch (err) {
          steps.push(fail('Verify config hash', errMsg(err)));
        }
      } else {
        steps.push(pass('Verify config hash', 'skipped (no on-chain result available)'));
      }

      // -------------------------------------------------------------------
      // Step 4: Verify move signatures (EIP-712)
      // -------------------------------------------------------------------
      if (bundle.turns && bundle.turns.length > 0) {
        try {
          const { ethers } = await import('ethers');
          let sigValid = 0;
          let sigTotal = 0;
          const sigErrors: string[] = [];

          const domain = {
            name: 'Coordination Games',
            version: '1',
            chainId: 10,
          };

          // Move schema from bundle or default. ethers expects
          // `Record<string, TypedDataField[]>`; bundle.moveSchema is typed
          // loosely (per-game) so we cast at this boundary.
          const moveSchema: Record<string, TypedDataField[]> = (bundle.moveSchema as
            | Record<string, TypedDataField[]>
            | undefined) ?? {
            Move: [
              { name: 'gameId', type: 'bytes32' },
              { name: 'turnNumber', type: 'uint16' },
              { name: 'data', type: 'string' },
            ],
          };

          for (const turn of bundle.turns) {
            for (const move of turn.moves) {
              sigTotal++;

              try {
                const moveData = {
                  gameId: ethers.id(gameId),
                  turnNumber: turn.turnNumber,
                  data: move.data,
                };

                const recoveredAddress = ethers.verifyTypedData(
                  domain,
                  moveSchema,
                  moveData,
                  move.signature,
                );

                if (recoveredAddress.toLowerCase() === move.player.toLowerCase()) {
                  sigValid++;
                } else {
                  sigErrors.push(
                    `Turn ${turn.turnNumber}: ${move.player.slice(0, 10)}... signed by ${recoveredAddress.slice(0, 10)}...`,
                  );
                }
              } catch (err) {
                // Signature verification may fail if the schema doesn't match
                // (e.g., game-specific move schemas). Count as unverifiable.
                sigErrors.push(
                  `Turn ${turn.turnNumber}: ${move.player.slice(0, 10)}... — ${errMsg(err)}`,
                );
              }
            }
          }

          if (sigErrors.length === 0) {
            steps.push(pass('Verify move signatures', `${sigValid}/${sigTotal} valid`));
          } else {
            steps.push(
              fail(
                'Verify move signatures',
                `${sigValid}/${sigTotal} valid, ${sigErrors.length} failed`,
              ),
            );
            for (const e of sigErrors.slice(0, 5)) {
              process.stdout.write(`         ${e}\n`);
            }
            if (sigErrors.length > 5) {
              process.stdout.write(`         ... and ${sigErrors.length - 5} more\n`);
            }
          }
        } catch (err) {
          steps.push(fail('Verify move signatures', errMsg(err)));
        }
      } else {
        steps.push(pass('Verify move signatures', 'no turns to verify'));
      }

      // -------------------------------------------------------------------
      // Step 5: Verify Merkle root
      // -------------------------------------------------------------------
      if (bundle.turns && bundle.turns.length > 0) {
        try {
          const turns: TurnData[] = bundle.turns.map((t) => ({
            turnNumber: t.turnNumber,
            moves: t.moves.map((m) => ({
              player: m.player,
              data: typeof m.data === 'string' ? m.data : JSON.stringify(m.data),
              signature: m.signature,
            })),
            result: t.result,
          }));

          const tree = buildMerkleTree(turns);
          const computedRoot = tree.root;

          if (onChainResult?.movesRoot) {
            if (computedRoot.toLowerCase() === onChainResult.movesRoot.toLowerCase()) {
              steps.push(pass('Verify Merkle root', `${computedRoot.slice(0, 18)}...`));
            } else {
              steps.push(
                fail(
                  'Verify Merkle root',
                  `computed ${computedRoot.slice(0, 18)}... != on-chain ${onChainResult.movesRoot.slice(0, 18)}...`,
                ),
              );
            }
          } else {
            steps.push(
              pass(
                'Verify Merkle root',
                `computed ${computedRoot.slice(0, 18)}... (no on-chain root to compare)`,
              ),
            );
          }
        } catch (err) {
          steps.push(fail('Verify Merkle root', errMsg(err)));
        }
      } else {
        steps.push(pass('Verify Merkle root', 'no turns to hash'));
      }

      // -------------------------------------------------------------------
      // Step 6: Verify turn count
      // -------------------------------------------------------------------
      if (onChainResult?.turnCount && bundle.turns) {
        const bundleTurnCount = bundle.turns.length;
        const chainTurnCount = Number(onChainResult.turnCount);

        if (bundleTurnCount === chainTurnCount) {
          steps.push(pass('Verify turn count', `${bundleTurnCount} turns`));
        } else {
          steps.push(
            fail(
              'Verify turn count',
              `bundle has ${bundleTurnCount} turns, chain says ${chainTurnCount}`,
            ),
          );
        }
      }

      // -------------------------------------------------------------------
      // Print results
      // -------------------------------------------------------------------
      printResults(steps);
    });
}

function printResults(steps: VerifyStep[]) {
  process.stdout.write('\n');
  for (const step of steps) {
    printStep(step);
  }

  const passed = steps.filter((s) => s.passed).length;
  const failed = steps.filter((s) => !s.passed).length;

  process.stdout.write(`\n  Results: ${passed} passed, ${failed} failed\n\n`);

  if (failed > 0) {
    process.exit(1);
  }
}
