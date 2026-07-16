import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runLocalTournament } from '@coordination-games/game-tragedy-of-the-commons';
import {
  deriveTragedyPromiseOutcomes,
  projectTragedyPromiseTrust,
  type VerifiedTragedyPromiseEvidenceReference,
  verifyTragedyPromiseEvidence,
} from '@coordination-games/plugin-trust-projector-tragedy';
import {
  createInMemoryEasGateway,
  createInMemoryPromiseOutcomeAnchorStore,
  createPromiseOutcomeAnchor,
} from '@coordination-games/trust';
import { buildTragedyPromiseEvidence } from './lib/tragedy-trust-evidence.js';
import {
  createTragedyTrustDemoFixture,
  TRAGEDY_TRUST_DEMO_ANCHORED_AT,
  TRAGEDY_TRUST_DEMO_DIDS,
} from './lib/tragedy-trust-fixture.js';

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

function verifyEvidenceRecords(
  records: readonly ReturnType<typeof buildTragedyPromiseEvidence>[],
): readonly VerifiedTragedyPromiseEvidenceReference[] {
  return records.map((record) => {
    const verification = verifyTragedyPromiseEvidence(record.artifact);
    if (verification.kind !== 'verified') {
      throw new TragedyTrustDemoError(`evidence rejected: ${verification.reason}`);
    }
    return {
      verified: verification.verified,
      evidence: { uri: record.uri, cid: record.cid },
    };
  });
}

export async function buildTragedyTrustDemoArtifact() {
  const fixture = createTragedyTrustDemoFixture();
  const tournament = runLocalTournament(fixture.tournamentInput);
  const evidenceRecords = fixture.commitments.map((commitment) =>
    buildTragedyPromiseEvidence(tournament, commitment),
  );
  const verifiedEvidence = verifyEvidenceRecords(evidenceRecords);
  const derived = deriveTragedyPromiseOutcomes({
    didByPlayerId: TRAGEDY_TRUST_DEMO_DIDS,
    evidence: verifiedEvidence,
    observedAt: TRAGEDY_TRUST_DEMO_ANCHORED_AT,
  });
  if (derived.kind === 'rejected') {
    throw new TragedyTrustDemoError(`event derivation rejected: ${derived.reason}`);
  }
  const projections = [...new Set(derived.events.map((event) => event.subjectDid))].map(
    (subjectDid) => {
      const projected = projectTragedyPromiseTrust({
        subjectDid,
        events: derived.events.filter((event) => event.subjectDid === subjectDid),
      });
      if (projected.kind === 'rejected') {
        throw new TragedyTrustDemoError(`projection rejected: ${projected.reason}`);
      }
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
    derived.events.map(async (event) => {
      const anchored = await anchor.anchor(event, TRAGEDY_TRUST_DEMO_ANCHORED_AT);
      if (anchored.kind !== 'anchored') {
        throw new TragedyTrustDemoError(`anchor rejected: ${anchored.reason}`);
      }
      const query = await anchor.query(anchored.record.attestationUid);
      if (query.kind !== 'verified') {
        throw new TragedyTrustDemoError(`query rejected: ${query.kind}`);
      }
      return { record: anchored.record, query };
    }),
  );
  return {
    demoVersion: 'tragedy-portable-trust-demo/v2',
    ordering: fixture.ordering,
    tournament: {
      games: tournament.games.map((game) => ({
        gameId: game.gameId,
        actualRounds: game.actualRounds,
      })),
    },
    promiseEvidence: evidenceRecords,
    verifiedEvidence: verifiedEvidence.map((entry) => entry.verified),
    events: derived.events,
    projections,
    attestations,
  } as const;
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
