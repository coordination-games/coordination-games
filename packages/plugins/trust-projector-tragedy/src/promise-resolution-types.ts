import type { PromiseOutcome } from '@coordination-games/trust';

export const TRAGEDY_PUBLIC_PROMISE_VERSION = 'tragedy-public-promise/v2' as const;
export const TRAGEDY_PROMISE_COMMITMENT_VERSION = 'tragedy-public-promise-commitment/v1' as const;
export const TRAGEDY_PUBLIC_ACTION_VERSION = 'tragedy-public-action/v2' as const;
export const TRAGEDY_PROMISE_DERIVATION_VERSION = 'tragedy-action-match/v2' as const;

export const TRAGEDY_PROMISE_ACTION_TYPES = {
  place_starting_camp: true,
  offer_trade: true,
  build_road: true,
  build_structure: true,
  upgrade_structure: true,
  extract_tile: true,
  convert_timber_to_energy: true,
  pass: true,
} as const;

export type TragedyPromiseActionType = keyof typeof TRAGEDY_PROMISE_ACTION_TYPES;

export function isTragedyPromiseActionType(value: unknown): value is TragedyPromiseActionType {
  return typeof value === 'string' && Object.hasOwn(TRAGEDY_PROMISE_ACTION_TYPES, value);
}

export type TragedyPublicPromise = Readonly<{
  readonly version: typeof TRAGEDY_PUBLIC_PROMISE_VERSION;
  readonly visibility: 'public';
  readonly promiseId: string;
  readonly tournamentId: string;
  readonly gameIndex: number;
  readonly gameId: string;
  readonly round: number;
  readonly promisorPlayerId: string;
  readonly expectedActionType: TragedyPromiseActionType;
}>;

export type TragedyPromiseCommitment = Readonly<{
  readonly version: typeof TRAGEDY_PROMISE_COMMITMENT_VERSION;
  readonly promise: TragedyPublicPromise;
  readonly digest: `0x${string}`;
}>;

export type TragedyPublicActionObservation = Readonly<{
  readonly version: typeof TRAGEDY_PUBLIC_ACTION_VERSION;
  readonly visibility: 'public';
  readonly gameId: string;
  readonly playerId: string;
  readonly round: number;
  readonly actionType: TragedyPromiseActionType;
  readonly botDecisionEventIndex: number;
  readonly actionResultEventIndex: number;
  readonly sourceEventHash: `0x${string}`;
}>;

export type TragedyPromiseCommitmentResult =
  | Readonly<{
      readonly kind: 'committed';
      readonly commitments: readonly TragedyPromiseCommitment[];
    }>
  | Readonly<{
      readonly kind: 'rejected';
      readonly reason: 'invalid-promise' | 'duplicate-promise-id' | 'duplicate-promise-target';
    }>;

export type TragedyPromiseResolution =
  | Readonly<{ readonly kind: 'resolved'; readonly outcome: PromiseOutcome }>
  | Readonly<{
      readonly kind: 'rejected';
      readonly reason: 'invalid-promise' | 'invalid-observation' | 'observation-mismatch';
    }>;
