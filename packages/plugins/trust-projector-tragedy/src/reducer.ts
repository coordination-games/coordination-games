import type {
  AttestationV1,
  JsonObject,
  TrustCardV1,
  TrustEvidenceEnvelopeV1,
  TrustEvidenceRefV1,
  TrustSignalV1,
} from '@coordination-games/engine';
import { keccak256CanonicalJson } from '@coordination-games/engine';
import {
  ATTESTATION_RELAY_TYPE,
  TRAGEDY_GAME_ID,
  type TragedyAttestation,
  type TrustProjectionArtifacts,
  type TrustProjectionInput,
  type TrustProjectorMeta,
  type VisibleTragedyPlayerSnapshot,
} from './types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function visibleArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function recordArray(value: unknown): Record<string, unknown>[] {
  return visibleArray(value).filter(isRecord);
}

function stringArray(value: unknown): string[] {
  return visibleArray(value).filter((item): item is string => typeof item === 'string');
}

function sumVisibleResources(value: unknown): number {
  if (!isRecord(value)) return 0;
  let total = 0;
  for (const next of Object.values(value)) {
    if (typeof next === 'number' && Number.isFinite(next)) total += next;
  }
  return total;
}

function relayAttestations(relayMessages: readonly unknown[]): TragedyAttestation[] {
  return relayMessages.flatMap((message) => {
    if (!isRecord(message) || message.type !== ATTESTATION_RELAY_TYPE) return [];
    return isAttestation(message.data) ? [message.data] : [];
  });
}

export function isAttestation(value: unknown): value is AttestationV1 {
  if (!isRecord(value)) return false;
  if (value.schemaVersion !== 'attestation/v1') return false;
  if (typeof value.id !== 'string' || typeof value.issuer !== 'string') return false;
  if (
    value.issuerKind !== 'agent' &&
    value.issuerKind !== 'system' &&
    value.issuerKind !== 'plugin'
  )
    return false;
  if (typeof value.subject !== 'string' || !isRecord(value.claim)) return false;
  const claim = value.claim;
  return typeof claim.type === 'string' && isRecord(claim.data);
}

export function projectTragedyTrust(input: TrustProjectionInput): TrustProjectionArtifacts {
  const meta = normalizeMeta(input.state, input.meta);
  if (!meta || meta.gameType !== TRAGEDY_GAME_ID || !isRecord(input.state)) {
    return { cards: [], envelopes: [] };
  }

  const attestations = [
    ...(input.attestations ?? []),
    ...relayAttestations(input.relayMessages ?? []),
  ].filter(isAttestation);
  const players = visibleArray(input.state.players).filter(isRecord);
  if (players.length === 0) return { cards: [], envelopes: [] };

  const round = finiteNumber(input.state.round, meta.progressCounter ?? 0);
  const phase = text(input.state.phase, meta.finished ? 'finished' : 'playing');
  const observedAt = new Date().toISOString();

  const cards: TrustCardV1[] = [];
  const envelopes: TrustEvidenceEnvelopeV1[] = [];
  for (const player of players) {
    const snapshot = snapshotPlayer(player, input.state, meta, attestations);
    if (!snapshot) continue;
    const evidenceRefs = evidenceRefsFor(snapshot.playerId, attestations, round);
    const envelope = createEvidenceEnvelope(snapshot, meta, round, phase, observedAt, evidenceRefs);
    envelopes.push(envelope);
    cards.push(createTrustCard(snapshot, observedAt, evidenceRefs));
  }
  return { cards, envelopes };
}

function normalizeMeta(
  state: unknown,
  meta: TrustProjectorMeta | undefined,
): TrustProjectorMeta | null {
  if (meta) return meta;
  if (!isRecord(state)) return null;
  const gameType = text(state.gameType, text(state.type));
  const gameId = text(state.gameId, 'unknown-game');
  return gameType ? { gameId, gameType } : null;
}

function snapshotPlayer(
  player: Record<string, unknown>,
  state: unknown,
  meta: TrustProjectorMeta,
  attestations: readonly TragedyAttestation[],
): VisibleTragedyPlayerSnapshot | null {
  const playerId = text(player.id);
  if (!playerId) return null;
  const stateRecord = isRecord(state) ? state : {};
  const regionsControlled = stringArray(player.regionsControlled);
  const ownedStructureIds = new Set(stringArray(player.ownedStructureIds));
  const ownedRoadIds = new Set(stringArray(player.ownedRoadIds));
  const playerStructures = recordArray(player.structures);
  const playerRoads = recordArray(player.roads);
  const playerTiles = recordArray(player.tiles);
  const allStructures =
    playerStructures.length > 0 ? playerStructures : recordArray(stateRecord.structures);
  const allRoads = playerRoads.length > 0 ? playerRoads : recordArray(stateRecord.roads);
  const allTiles = playerTiles.length > 0 ? playerTiles : recordArray(stateRecord.tiles);
  const isV2 =
    ownedStructureIds.size > 0 ||
    ownedRoadIds.size > 0 ||
    allStructures.length > 0 ||
    allRoads.length > 0;
  const myStructures = allStructures.filter((structure) => {
    const structureId = text(structure.id);
    return text(structure.ownerId) === playerId || ownedStructureIds.has(structureId);
  });
  const myRoads = allRoads.filter((road) => {
    const roadId = text(road.id);
    return text(road.ownerId) === playerId || ownedRoadIds.has(roadId);
  });
  const totalTileHealth = allTiles.reduce((sum, tile) => sum + finiteNumber(tile.health), 0);
  const totalTileMaxHealth = allTiles.reduce((sum, tile) => sum + finiteNumber(tile.maxHealth), 0);
  const commonsHealthPercent =
    totalTileMaxHealth > 0
      ? Math.round((totalTileHealth / totalTileMaxHealth) * 100)
      : finiteNumber(stateRecord.commonsHealthPercent);
  const latestAction = [...attestations]
    .reverse()
    .find(
      (attestation) =>
        attestation.subject === playerId && attestation.claim.type === 'tragedy.round_choice.v1',
    );
  const actionType = isRecord(latestAction?.claim.data)
    ? text(latestAction?.claim.data.actionType)
    : '';
  const lastAction = text(player.lastAction, actionType);
  return {
    playerId,
    displayName: meta.handleMap?.[playerId] ?? playerId,
    influence: finiteNumber(player.influence),
    victoryPoints: finiteNumber(player.vp, finiteNumber(player.victoryPoints)),
    totalResources: finiteNumber(player.totalResources, sumVisibleResources(player.resources)),
    ...(regionsControlled.length > 0 ? { regionsControlled: regionsControlled.length } : {}),
    structureCount: isV2 ? myStructures.length : 0,
    roadCount: isV2 ? myRoads.length : 0,
    solarCount: isV2
      ? myStructures.filter(
          (structure) => structure.type === 'solar-farm' || structure.type === 'solar-array',
        ).length
      : 0,
    extractionPressure: isV2
      ? myStructures.reduce(
          (sum, structure) => sum + finiteNumber(structure.extractionsThisRound),
          0,
        )
      : 0,
    commonsHealthPercent,
    ...(lastAction ? { lastAction } : {}),
  };
}

function evidenceRefsFor(
  playerId: string,
  attestations: readonly TragedyAttestation[],
  round: number,
): TrustEvidenceRefV1[] {
  const refs = attestations
    .filter((attestation) => attestation.subject === playerId)
    .slice(-5)
    .map((attestation) => ({
      kind: attestation.claim.type,
      id: attestation.id,
      visibility: 'public' as const,
      round: attestation.round ?? round,
      summary: attestation.note ?? attestation.claim.type,
    }));
  if (refs.length > 0) return refs;
  return [
    {
      kind: 'tragedy.visible-state',
      id: `${playerId}:visible:${round}`,
      visibility: 'viewer-visible',
      round,
      summary: 'Projected from viewer-visible game state.',
    },
  ];
}

function createEvidenceEnvelope(
  snapshot: VisibleTragedyPlayerSnapshot,
  meta: TrustProjectorMeta,
  round: number,
  phase: string,
  observedAt: string,
  evidenceRefs: TrustEvidenceRefV1[],
): TrustEvidenceEnvelopeV1 {
  const payload: JsonObject = {
    gameId: meta.gameId,
    gameType: meta.gameType,
    phase,
    round,
    progressCounter: meta.progressCounter ?? round,
    player: {
      id: snapshot.playerId,
      displayName: snapshot.displayName ?? snapshot.playerId,
      influence: snapshot.influence,
      victoryPoints: snapshot.victoryPoints,
      totalResources: snapshot.totalResources,
      ...(snapshot.regionsControlled != null
        ? { regionsControlled: snapshot.regionsControlled }
        : {}),
      structureCount: snapshot.structureCount,
      roadCount: snapshot.roadCount,
      solarCount: snapshot.solarCount,
      extractionPressure: snapshot.extractionPressure,
      commonsHealthPercent: snapshot.commonsHealthPercent,
      ...(snapshot.lastAction ? { lastAction: snapshot.lastAction } : {}),
    },
  };
  const id = keccak256CanonicalJson({
    eventType: 'tragedy.turn.outcome',
    subject: snapshot.playerId,
    payload,
  });
  return {
    schemaVersion: 'trust-evidence/v1',
    id,
    eventType: 'tragedy.turn.outcome',
    category: 'outcome',
    subject: snapshot.playerId,
    issuer: `${meta.gameType}:${meta.gameId}`,
    issuedAt: observedAt,
    payload,
    privacy: {
      publishable: true,
      redaction: 'aggregated',
      containsPrivateChat: false,
      containsHiddenState: false,
    },
    evidenceRefs,
  };
}

function createTrustCard(
  snapshot: VisibleTragedyPlayerSnapshot,
  observedAt: string,
  evidenceRefs: TrustEvidenceRefV1[],
): TrustCardV1 {
  const updatedAt = Date.parse(observedAt);
  return {
    schemaVersion: 'trust-card/v1',
    agentId: snapshot.playerId,
    subjectId: snapshot.playerId,
    headline: 'Viewer-visible trust context',
    summary: visibleTragedySummary(snapshot),
    signals: createVisibleTragedySignals(snapshot, evidenceRefs),
    caveats: [
      'Derived only from viewer-visible Tragedy of the Commons state and public attestation relays.',
      'Does not include private DMs, hidden intent, or cross-game history yet.',
    ],
    evidenceRefs,
    ...(Number.isFinite(updatedAt) ? { updatedAt } : { updatedAt: Date.now() }),
  };
}

function visibleTragedySummary(snapshot: VisibleTragedyPlayerSnapshot): string {
  const name = snapshot.displayName ?? snapshot.playerId;
  if (hasV2Shape(snapshot)) {
    return `${name} has ${snapshot.victoryPoints} VP, ${snapshot.influence} influence, ${snapshot.totalResources} visible resources, ${snapshot.structureCount} structures, ${snapshot.roadCount} roads, ${snapshot.solarCount} solar investments, ${snapshot.extractionPressure} extractions this round, and commons health is ${snapshot.commonsHealthPercent}%.`;
  }
  return `${name} has ${snapshot.victoryPoints} VP, ${snapshot.influence} influence, ${snapshot.totalResources} visible resources, and controls ${snapshot.regionsControlled ?? 0} regions.`;
}

function hasV2Shape(snapshot: VisibleTragedyPlayerSnapshot): boolean {
  return (
    snapshot.structureCount > 0 ||
    snapshot.roadCount > 0 ||
    snapshot.solarCount > 0 ||
    snapshot.extractionPressure > 0
  );
}

function createVisibleTragedySignals(
  snapshot: VisibleTragedyPlayerSnapshot,
  evidenceRefs: TrustEvidenceRefV1[],
): TrustSignalV1[] {
  const signals: TrustSignalV1[] = [
    {
      label: 'Visible table position',
      stance: snapshot.victoryPoints > 0 || snapshot.influence > 0 ? 'positive' : 'informational',
      summary: `${snapshot.victoryPoints} VP and ${snapshot.influence} influence are visible to this viewer.`,
      confidence: 0.7,
      evidenceRefs,
    },
    {
      label: 'Resource pressure context',
      stance: snapshot.totalResources > 8 ? 'positive' : 'informational',
      summary: `${snapshot.totalResources} visible resources indicate current capacity, not intent.`,
      confidence: 0.55,
      evidenceRefs,
    },
  ];
  if (snapshot.lastAction) {
    signals.push({
      label: 'Latest visible action',
      stance: actionStance(snapshot.lastAction),
      summary: `Latest visible action: ${snapshot.lastAction}.`,
      confidence: 0.65,
      evidenceRefs,
    });
  }
  if (hasV2Shape(snapshot)) {
    signals.push(
      {
        label: 'Structural network',
        stance:
          snapshot.structureCount > 0 || snapshot.roadCount > 0 ? 'positive' : 'informational',
        summary: `${snapshot.structureCount} structures and ${snapshot.roadCount} roads are visible.`,
        confidence: 0.7,
        evidenceRefs,
      },
      {
        label: 'Solar investment',
        stance: snapshot.solarCount > 0 ? 'positive' : 'informational',
        summary: `${snapshot.solarCount} solar installations are visible.`,
        confidence: 0.65,
        evidenceRefs,
      },
      {
        label: 'Extraction pressure',
        stance: snapshot.extractionPressure === 0 ? 'positive' : 'informational',
        summary: `${snapshot.extractionPressure} total extractions this round across owned structures.`,
        confidence: 0.6,
        evidenceRefs,
      },
      {
        label: 'Commons health',
        stance:
          snapshot.commonsHealthPercent >= 70
            ? 'positive'
            : snapshot.commonsHealthPercent >= 40
              ? 'informational'
              : 'negative',
        summary: `Average tile health is ${snapshot.commonsHealthPercent}%.`,
        confidence: 0.75,
        evidenceRefs,
      },
    );
  }
  return signals;
}

function actionStance(action: string): TrustSignalV1['stance'] {
  if (action === 'build_settlement' || action === 'tragedy.settlement_built.v1') return 'positive';
  if (action === 'build_road' || action === 'tragedy.road_built.v1') return 'positive';
  if (action === 'build_structure' || action === 'tragedy.structure_built.v1') return 'positive';
  if (action === 'upgrade_structure' || action === 'tragedy.structure_upgraded.v1')
    return 'positive';
  if (action === 'extract_commons' || action === 'tragedy.ecosystem_impact.v1')
    return 'informational';
  if (action === 'extract_tile' || action === 'tragedy.tile_extracted.v1') return 'informational';
  if (action === 'convert_timber_to_energy' || action === 'tragedy.timber_converted.v1')
    return 'informational';
  if (action === 'offer_trade' || action === 'tragedy.trade_offer.v1') return 'informational';
  return 'unknown';
}
