import {
  type CoordinationGameTrustCardV1,
  type CreateTragedyVisibleTrustResult,
  createTragedyVisibleTrust,
} from '@agentic-trust/cg-adapter';
import type { TrustEvidenceEnvelopeV1 } from '@agentic-trust/core';
import type { TrustCardV1 } from '@coordination-games/engine';

export interface TrustCardGameMeta {
  readonly gameId: string;
  readonly gameType: string;
  readonly handleMap: Record<string, string>;
  readonly finished: boolean;
}

export interface VisibleTrustArtifacts {
  readonly cards: TrustCardV1[];
  readonly envelopes: TrustEvidenceEnvelopeV1[];
}

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

function sumVisibleResources(value: unknown): number {
  if (!isRecord(value)) return 0;
  let total = 0;
  for (const next of Object.values(value)) {
    if (typeof next === 'number' && Number.isFinite(next)) total += next;
  }
  return total;
}

function toEngineTrustCard(card: CoordinationGameTrustCardV1): TrustCardV1 {
  return {
    schemaVersion: card.schemaVersion,
    agentId: card.agentId,
    subjectId: card.subjectId,
    headline: card.headline,
    summary: card.summary,
    signals: card.signals.map((signal) => ({
      label: signal.label,
      stance: signal.stance,
      summary: signal.summary,
      ...(signal.confidence !== undefined ? { confidence: signal.confidence } : {}),
      ...(signal.evidenceRefs !== undefined
        ? { evidenceRefs: signal.evidenceRefs.map((ref) => ({ ...ref })) }
        : {}),
    })),
    caveats: [...card.caveats],
    evidenceRefs: card.evidenceRefs.map((ref) => ({ ...ref })),
    ...(card.updatedAt !== undefined ? { updatedAt: card.updatedAt } : {}),
  };
}

export function buildVisibleTrustCards(
  state: unknown,
  meta: TrustCardGameMeta,
  progressCounter: number | null,
): TrustCardV1[] {
  return buildVisibleTrustArtifacts(state, meta, progressCounter).cards;
}

export function buildVisibleTrustArtifacts(
  state: unknown,
  meta: TrustCardGameMeta,
  progressCounter: number | null,
): VisibleTrustArtifacts {
  if (meta.gameType !== 'tragedy-of-the-commons' || !isRecord(state)) {
    return { cards: [], envelopes: [] };
  }
  const players = visibleArray(state.players).filter(isRecord);
  if (players.length === 0) return { cards: [], envelopes: [] };
  const round = finiteNumber(state.round, progressCounter ?? 0);
  const phase = text(state.phase, meta.finished ? 'finished' : 'playing');
  const observedAt = new Date().toISOString();
  const trustInputs = players.flatMap((player) => {
    const agentId = text(player.id);
    if (!agentId) return [];
    const influence = finiteNumber(player.influence);
    const vp = finiteNumber(player.vp);
    const totalResources = finiteNumber(
      player.totalResources,
      sumVisibleResources(player.resources),
    );
    const regionsControlled = visibleArray(player.regionsControlled).filter(
      (region): region is string => typeof region === 'string',
    );
    const lastAction = text(player.lastAction);
    return [
      {
        gameId: meta.gameId,
        gameType: meta.gameType,
        round,
        phase,
        ...(progressCounter !== null ? { progressCounter } : {}),
        observedAt,
        subject: {
          playerId: agentId,
          displayName: meta.handleMap[agentId] ?? agentId,
          influence,
          victoryPoints: vp,
          totalResources,
          regionsControlled: regionsControlled.length,
          ...(lastAction ? { lastAction } : {}),
        },
      },
    ];
  });
  const results: CreateTragedyVisibleTrustResult[] = trustInputs.map((input) =>
    createTragedyVisibleTrust(input),
  );
  return {
    cards: results.map((result) => toEngineTrustCard(result.coordinationGameCard)),
    envelopes: results.map((result) => result.envelope),
  };
}

export function withVisibleTrustCards(
  state: unknown,
  meta: TrustCardGameMeta,
  progressCounter: number | null,
): unknown {
  if (!isRecord(state)) return state;
  return {
    ...state,
    trustCards: buildVisibleTrustCards(state, meta, progressCounter),
  };
}
