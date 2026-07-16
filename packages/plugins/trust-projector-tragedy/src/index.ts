import type { AttestationV1, RelayEnvelope, ToolPlugin } from '@coordination-games/engine';
import { registerPluginRelayTypes } from '@coordination-games/engine';
import { z } from 'zod';
import { isAttestation, projectTragedyTrust } from './reducer.js';
import {
  ATTESTATION_RELAY_TYPE,
  TRUST_PROJECTOR_TRAGEDY_PLUGIN_ID,
  type TrustProjectionArtifacts,
  type TrustProjectorMeta,
} from './types.js';

const JsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

export const AttestationV1Schema = z
  .object({
    schemaVersion: z.literal('attestation/v1'),
    id: z.string().min(1),
    issuer: z.string().min(1),
    issuerKind: z.enum(['agent', 'system', 'plugin']),
    subject: z.string().min(1),
    claim: z.object({
      type: z.string().min(1),
      data: z.record(z.string(), JsonValueSchema),
    }),
    note: z.string().optional(),
    confidence: z.number().min(0).max(1).optional(),
    round: z.number().int().nonnegative().optional(),
    issuedAt: z.string().optional(),
    evidenceRefs: z
      .array(
        z.object({
          kind: z.string(),
          id: z.string(),
          visibility: z.enum(['public', 'viewer-visible']),
          round: z.number().optional(),
          relayIndex: z.number().optional(),
          summary: z.string().optional(),
        }),
      )
      .optional(),
  })
  .passthrough();

export function extractAttestations(relayMessages: readonly unknown[]): AttestationV1[] {
  return relayMessages.flatMap((message) => {
    if (!isRelayEnvelope(message) || message.type !== ATTESTATION_RELAY_TYPE) return [];
    return isAttestation(message.data) ? [message.data] : [];
  });
}

export function projectTrustCards(input: {
  readonly state: unknown;
  readonly meta?: TrustProjectorMeta;
  readonly relayMessages?: readonly unknown[];
}): TrustProjectionArtifacts {
  return projectTragedyTrust(input);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isRelayEnvelope(value: unknown): value is RelayEnvelope {
  return isRecord(value) && typeof value.type === 'string' && 'data' in value;
}

export const TrustProjectorTragedyPlugin: ToolPlugin = {
  id: TRUST_PROJECTOR_TRAGEDY_PLUGIN_ID,
  version: '0.1.0',
  modes: [{ name: 'trust-cards', consumes: [], provides: ['trust-cards'] }],
  purity: 'pure',
  relayTypes: { [ATTESTATION_RELAY_TYPE]: AttestationV1Schema },
  agentEnvelopeKeys: { 'trust-cards': 'trustCards' },
  handleData(_mode: string, inputs: Map<string, unknown>): Map<string, unknown> {
    const relayMessages = Array.isArray(inputs.get('relay-messages'))
      ? (inputs.get('relay-messages') as unknown[])
      : [];
    const meta = isRecord(inputs.get('game-meta'))
      ? (inputs.get('game-meta') as TrustProjectorMeta)
      : undefined;
    const input = {
      state: inputs.get('game-state'),
      relayMessages,
      ...(meta ? { meta } : {}),
    };
    const { cards } = projectTragedyTrust(input);
    return new Map([['trust-cards', cards]]);
  },
};

registerPluginRelayTypes(TrustProjectorTragedyPlugin);

export {
  deriveTragedyBehaviorReputation,
  mapTragedyBehaviorReputationToTrustEvents,
  TRAGEDY_BEHAVIOR_REPUTATION_POLICY,
} from './behavior-reputation.js';
export {
  type PublicTragedyArtifact,
  TRAGEDY_BEHAVIOR_REPUTATION_VERSION,
  type TragedyBehaviorEvent,
  type TragedyBehaviorOutcome,
  type TragedyBehaviorReputation,
  type TragedyBehaviorReputationInput,
  type TragedyBehaviorTrustMapping,
  type TragedyBehaviorTrustMappingInput,
} from './behavior-reputation-types.js';
export {
  mapSettledTragedyPromiseOutcomes,
  projectTragedyPromiseTrust,
  type TragedyPromiseOutcomeInput,
  type TragedyPromiseOutcomeMapping,
  type TragedyPromiseTrustProjection,
  type TragedySettledPromiseResolution,
} from './portable-trust.js';
export {
  hashTragedyActionSource,
  hashTragedyTranscriptProof,
  TRAGEDY_ACTION_SOURCE_VERSION,
  TRAGEDY_PROMISE_EVIDENCE_VERSION,
  TRAGEDY_PROMISE_TRANSCRIPT_VERSION,
  type TragedyActionResultSource,
  type TragedyBotDecisionSource,
  type TragedyPromiseEvidence,
  type TragedyPromiseEvidenceVerification,
  type TragedyPromiseTranscriptProof,
  type TragedySettlementSource,
  type VerifiedTragedyPromiseEvidence,
  verifyTragedyPromiseEvidence,
} from './promise-evidence.js';
export {
  deriveTragedyPromiseOutcomes,
  type TragedyDerivedPromiseOutcome,
  type VerifiedTragedyPromiseEvidenceReference,
} from './promise-outcome-events.js';
export {
  commitTragedyPublicPromises,
  isTragedyPromiseActionType,
  parseTragedyPublicActionObservation,
  parseTragedyPublicPromise,
  resolveTragedyPublicPromise,
  TRAGEDY_PROMISE_ACTION_TYPES,
  TRAGEDY_PROMISE_COMMITMENT_VERSION,
  TRAGEDY_PROMISE_DERIVATION_VERSION,
  TRAGEDY_PUBLIC_ACTION_VERSION,
  TRAGEDY_PUBLIC_PROMISE_VERSION,
  type TragedyPromiseActionType,
  type TragedyPromiseCommitment,
  type TragedyPromiseCommitmentResult,
  type TragedyPromiseResolution,
  type TragedyPublicActionObservation,
  type TragedyPublicPromise,
} from './promise-resolution.js';
export { isAttestation, projectTragedyTrust } from './reducer.js';
export {
  ATTESTATION_RELAY_TYPE,
  TRAGEDY_GAME_ID,
  TRUST_PROJECTOR_TRAGEDY_PLUGIN_ID,
  type TragedyAttestation,
  type TrustProjectionArtifacts,
  type TrustProjectionInput,
  type TrustProjectorMeta,
  type VisibleTragedyPlayerSnapshot,
} from './types.js';
