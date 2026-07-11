import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  type LocalTournamentResult,
  parseTournamentDemoPolicy,
  runLocalTournament,
  type TournamentDemoPolicy,
} from '@coordination-games/game-tragedy-of-the-commons';

type CliOptions = Readonly<{
  readonly seed: string;
  readonly entropy: string;
  readonly output: string;
  readonly policies: readonly string[];
}>;

function usage(): string {
  return [
    'Usage: npm run demo:tournament -- --seed <bytes32> --entropy <bytes32> --policy <json> --policy <json> --policy <json> --output <output-directory>',
    'Use a private evidence directory outside the worktree.',
  ].join('\n');
}

function parseArgs(args: readonly string[]): CliOptions {
  let seed: string | undefined;
  let entropy: string | undefined;
  let output: string | undefined;
  const policies: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    const next = args[index + 1];
    if (value === '--help') throw new Error(usage());
    if (next === undefined) throw new Error(`Missing value for ${value}\n${usage()}`);
    if (value === '--seed') seed = next;
    else if (value === '--entropy') entropy = next;
    else if (value === '--output') output = resolve(next);
    else if (value === '--policy') policies.push(resolve(next));
    else throw new Error(`Unknown argument ${value}\n${usage()}`);
    index += 1;
  }
  if (seed === undefined || entropy === undefined || output === undefined || policies.length !== 3)
    throw new Error(usage());
  return { seed, entropy, output, policies };
}

async function loadPolicy(path: string): Promise<TournamentDemoPolicy> {
  const sourceText = await readFile(path, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(sourceText);
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new Error(`Invalid policy JSON ${path}: ${error.message}`);
    throw error;
  }
  return parseTournamentDemoPolicy(parsed, path, sourceText);
}

function stringify(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === 'bigint' ? item.toString() : item,
  );
}

function manifest(
  result: LocalTournamentResult,
  policies: readonly TournamentDemoPolicy[],
): object {
  const distinct = (values: readonly string[]): boolean => new Set(values).size === values.length;
  const revealIndex = new Map<string, number>();
  result.transcript.forEach((event, index) => {
    if (event.kind === 'horizon_reveal' && typeof event.gameId === 'string')
      revealIndex.set(event.gameId, index);
  });
  return {
    version: 1,
    policies: policies.map((policy) => ({
      botName: policy.botName,
      model: policy.model,
      persona: policy.persona,
      sourcePath: policy.sourcePath,
      sha256: policy.sha256,
    })),
    games: result.games.map((game) => ({
      gameId: game.gameId,
      gameSeed: game.gameSeed,
      horizonCommitment: game.horizon.commitment,
      actualRounds: game.actualRounds,
      entryCost: game.entryCost.toString(),
    })),
    assertions: {
      twoGames: result.games.length === 2,
      distinctGameIds: distinct(result.games.map((game) => game.gameId)),
      distinctSeeds: distinct(result.games.map((game) => game.gameSeed)),
      distinctCommitments: distinct(result.games.map((game) => game.horizon.commitment)),
      roundsWithinBounds: result.games.every(
        (game) => game.actualRounds >= 2 && game.actualRounds <= 9,
      ),
      commitmentsVerify: result.games.every((game) => game.horizon.verified),
      endpointAbsentBeforeReveal: result.transcript.every((event, index) => {
        const revealAt =
          typeof event.gameId === 'string' ? revealIndex.get(event.gameId) : undefined;
        return (
          revealAt === undefined ||
          index >= revealAt ||
          !/stopRound|endpoint/i.test(stringify(event))
        );
      }),
      gameTwoEntryEscalated:
        (result.games[1]?.entryCost ?? 0n) >= (result.games[0]?.entryCost ?? 0n),
      treasuryTransferAccounting: result.games.every(
        (game) => game.payouts.playerTotal + game.payouts.treasuryDelta === 0n,
      ),
    },
  };
}

async function writeArtifacts(
  output: string,
  result: LocalTournamentResult,
  policies: readonly TournamentDemoPolicy[],
): Promise<void> {
  await mkdir(output, { recursive: true });
  const lines = result.transcript.map(stringify).join('\n').concat('\n');
  const markdown = result.transcript
    .map((event, index) => `- ${index + 1}. **${String(event.kind)}** ${stringify(event)}`)
    .join('\n')
    .concat('\n');
  await Promise.all([
    writeFile(resolve(output, 'private-transcript.jsonl'), lines),
    writeFile(resolve(output, 'private-transcript.md'), markdown),
    writeFile(
      resolve(output, 'replay-manifest.json'),
      `${stringify(manifest(result, policies))}\n`,
    ),
    writeFile(resolve(output, 'spectator-state.json'), `${stringify(result.publicSpectator)}\n`),
  ]);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const policies = await Promise.all(options.policies.map(loadPolicy));
  const result = runLocalTournament({
    tournamentId: 'task-12-local-demo',
    seed: options.seed,
    playerEntropy: options.entropy,
    policies,
  });
  await writeArtifacts(options.output, result, policies);
  process.stdout.write(`Task 12 tournament evidence written to ${options.output}\n`);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown tournament demo failure';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
