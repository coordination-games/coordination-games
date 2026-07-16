import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalizeJson } from '@coordination-games/engine';
import {
  parseTournamentDemoPolicy,
  runLocalTournament,
} from '@coordination-games/game-tragedy-of-the-commons';
import {
  mapSettledTragedyPromiseOutcomes,
  projectTragedyPromiseTrust,
} from '@coordination-games/plugin-trust-projector-tragedy';
import {
  createInMemoryEasGateway,
  createInMemoryPromiseOutcomeAnchorStore,
  createPromiseOutcomeAnchor,
} from '@coordination-games/trust';

const DEMO_DIDS = {
  'mint-mediator': 'did:plc:abcdefghijklmnopqrstuvwx',
  'ash-builder': 'did:plc:zyxwvutsrqponmlkjihgfedc',
  'hot-opportunist': 'did:plc:bcdefghijklmnopqrstuvwxy',
} as const;
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567' as const;
const SETTLEMENT_DID = 'did:plc:abcdefghijklmnopqrstuvwx' as const;
const ANCHORED_AT = '2026-07-16T12:00:00.000Z' as const;

export class TragedyTrustDemoError extends Error {
  readonly name = 'TragedyTrustDemoError';

  constructor(readonly reason: string) {
    super(`Tragedy trust demo failed: ${reason}`);
  }
}

function outputPath(args: readonly string[]): string | null {
  if (args.length === 0) return null;
  if (args.length === 2 && args[0] === '--output' && args[1] !== undefined) return resolve(args[1]);
  throw new TragedyTrustDemoError('Usage: npm run demo:trust -- [--output <json-file>]');
}

function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let result = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      result += BASE32[(value >>> (bits - 5)) & 31] ?? '';
      bits -= 5;
    }
  }
  if (bits > 0) result += BASE32[(value << (5 - bits)) & 31] ?? '';
  return result;
}

function cidForCanonicalArtifact(artifact: unknown): string {
  const digest = createHash('sha256').update(canonicalizeJson(artifact)).digest();
  return `b${base32(Uint8Array.from([1, 0x55, 0x12, 32, ...digest]))}`;
}

function policies() {
  return [
    parseTournamentDemoPolicy(
      {
        botName: 'mint-mediator',
        model: 'MiniMax-M2.5',
        persona: 'A consensus-first commons steward.',
        setup: { startingCamp: 'northWest' },
        roundRule: { action: { type: 'pass' } },
      },
      'trust-demo-mint-mediator.json',
    ),
    parseTournamentDemoPolicy(
      {
        botName: 'ash-builder',
        model: 'MiniMax-M2.5',
        persona: 'A disciplined public-works builder.',
        setup: { startingCamp: 'north' },
        roundRule: { action: { type: 'pass' } },
      },
      'trust-demo-ash-builder.json',
    ),
    parseTournamentDemoPolicy(
      {
        botName: 'hot-opportunist',
        model: 'MiniMax-M2.5',
        persona: 'A short-horizon resource opportunist.',
        setup: { startingCamp: 'south' },
        roundRule: { action: { type: 'pass' } },
      },
      'trust-demo-hot-opportunist.json',
    ),
  ] as const;
}

function settlementEvidence(
  tournament: ReturnType<typeof runLocalTournament>,
  gameId: string,
  sequence: number,
) {
  const game = tournament.games.find((candidate) => candidate.gameId === gameId);
  if (game === undefined) throw new TragedyTrustDemoError(`missing settled game ${gameId}`);
  const artifact = {
    settlementSequence: sequence,
    game: {
      gameId: game.gameId,
      gameSeed: game.gameSeed,
      actualRounds: game.actualRounds,
      horizon: game.horizon,
      entryCost: game.entryCost.toString(),
      payouts: {
        playerTotal: game.payouts.playerTotal.toString(),
        treasuryDelta: game.payouts.treasuryDelta.toString(),
        everyPlayerAboveEntryFloor: game.payouts.everyPlayerAboveEntryFloor,
      },
    },
    transcript: tournament.transcript.filter(
      (event) => event.gameId === gameId && ['outcome', 'settlement'].includes(String(event.kind)),
    ),
  };
  return {
    artifact,
    uri: `at://${SETTLEMENT_DID}/app.coordination-games.tragedy-settlement/${gameId}-${sequence}`,
    cid: cidForCanonicalArtifact(artifact),
  };
}

export async function buildTragedyTrustDemoArtifact() {
  const tournament = runLocalTournament({
    tournamentId: 'task-15-trust-demo',
    seed: `0x${'17'.repeat(32)}`,
    playerEntropy: `0x${'29'.repeat(32)}`,
    policies: policies(),
  });
  const game = tournament.games[0];
  if (game === undefined) throw new TragedyTrustDemoError('fixture did not settle a game');
  const keptEvidence = settlementEvidence(tournament, game.gameId, 1);
  const brokenEvidence = settlementEvidence(tournament, game.gameId, 2);
  const mapped = mapSettledTragedyPromiseOutcomes({
    gameType: 'tragedy-of-the-commons',
    didByPlayerId: DEMO_DIDS,
    resolutions: [
      {
        resolutionVersion: 'tragedy-promise-resolution/v1',
        visibility: 'public',
        gameId: game.gameId,
        sequence: 1,
        actorPlayerId: 'mint-mediator',
        subjectPlayerId: 'mint-mediator',
        outcome: 'kept',
        observedAt: ANCHORED_AT,
        evidence: { uri: keptEvidence.uri, cid: keptEvidence.cid },
      },
      {
        resolutionVersion: 'tragedy-promise-resolution/v1',
        visibility: 'public',
        gameId: game.gameId,
        sequence: 2,
        actorPlayerId: 'mint-mediator',
        subjectPlayerId: 'mint-mediator',
        outcome: 'broken',
        observedAt: ANCHORED_AT,
        evidence: { uri: brokenEvidence.uri, cid: brokenEvidence.cid },
      },
    ],
  });
  if (mapped.kind === 'rejected')
    throw new TragedyTrustDemoError(`event mapping rejected: ${mapped.reason}`);
  const projections = [...new Set(mapped.events.map((event) => event.subjectDid))].map(
    (subjectDid) => {
      const projected = projectTragedyPromiseTrust({
        subjectDid,
        events: mapped.events.filter((event) => event.subjectDid === subjectDid),
      });
      if (projected.kind === 'rejected')
        throw new TragedyTrustDemoError(`projection rejected: ${projected.reason}`);
      return projected;
    },
  );
  const gateway = createInMemoryEasGateway({
    chainId: 31_337,
    easContract: '0x1111111111111111111111111111111111111111',
    schemaUid: `0x${'11'.repeat(32)}`,
    attester: '0x2222222222222222222222222222222222222222',
  });
  const anchor = createPromiseOutcomeAnchor(gateway, createInMemoryPromiseOutcomeAnchorStore());
  const attestations = await Promise.all(
    mapped.events.map(async (event) => {
      const anchored = await anchor.anchor(event, ANCHORED_AT);
      if (anchored.kind !== 'anchored')
        throw new TragedyTrustDemoError(`anchor rejected: ${anchored.reason}`);
      const query = await anchor.query(anchored.record.attestationUid);
      if (query.kind !== 'verified')
        throw new TragedyTrustDemoError(`query rejected: ${query.kind}`);
      return { record: anchored.record, query };
    }),
  );
  return {
    demoVersion: 'tragedy-portable-trust-demo/v1',
    tournament: {
      games: tournament.games.map((entry) => ({
        gameId: entry.gameId,
        actualRounds: entry.actualRounds,
      })),
    },
    settlementEvidence: [keptEvidence, brokenEvidence],
    events: mapped.events,
    projections,
    attestations,
  };
}

export function serializeTragedyTrustDemoArtifact(artifact: unknown): string {
  return JSON.stringify(artifact, (_key: string, value: unknown) =>
    typeof value === 'bigint' ? { __bigint: value.toString() } : value,
  );
}

async function main(): Promise<void> {
  const target = outputPath(process.argv.slice(2));
  const json = `${serializeTragedyTrustDemoArtifact(await buildTragedyTrustDemoArtifact())}\n`;
  if (target !== null) {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, json, 'utf8');
  }
  process.stdout.write(json);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'Unknown Tragedy trust demo failure';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
