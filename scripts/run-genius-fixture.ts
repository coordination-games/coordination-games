import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { canonicalizeJson } from '@coordination-games/engine';
import { GENIUS_GAME_ID, runGeniusBotFixture } from '@coordination-games/game-genius';

class GeniusFixtureCliError extends Error {
  readonly name = 'GeniusFixtureCliError';
}

function outputPath(args: readonly string[]): string | null {
  if (args.length === 0) return null;
  if (args.length === 2 && args[0] === '--output' && args[1] !== undefined) {
    return resolve(args[1]);
  }
  throw new GeniusFixtureCliError('Usage: npm run demo:genius -- [--output <json-file>]');
}

async function main(): Promise<void> {
  const target = outputPath(process.argv.slice(2));
  const fixture = runGeniusBotFixture();
  const payload = {
    gameType: GENIUS_GAME_ID,
    config: fixture.config,
    actions: fixture.actions,
    outcome: fixture.outcome,
    finalState: fixture.state,
    transcript: fixture.transcript,
    publicHash: fixture.publicHash,
    replayEquivalent:
      canonicalizeJson(fixture.replay.state) === canonicalizeJson(fixture.state) &&
      canonicalizeJson(fixture.replay.outcome) === canonicalizeJson(fixture.outcome),
  };
  const json = `${canonicalizeJson(payload)}\n`;
  if (target !== null) {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, json, 'utf8');
  }
  process.stdout.write(json);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown Genius fixture failure';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
