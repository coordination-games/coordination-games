export type SettlementDelta = {
  readonly agentId: string;
  readonly delta: bigint;
};

export type TreasuryPlayerRow = {
  readonly id: string;
  readonly chainAgentId: number | null;
};

export type SettlementParticipants =
  | {
      readonly kind: 'ready';
      readonly playerIds: string[];
      readonly deltas: SettlementDelta[];
    }
  | { readonly kind: 'invalid'; readonly reason: string };

type AssembleSettlementParticipantsInput = {
  readonly playerIds: string[];
  readonly deltas: SettlementDelta[];
  readonly treasuryHandle: string | undefined;
  readonly findByHandle: (handle: string) => Promise<TreasuryPlayerRow | null>;
};

export async function assembleSettlementParticipants(
  input: AssembleSettlementParticipantsInput,
): Promise<SettlementParticipants> {
  if (input.treasuryHandle === undefined) {
    return { kind: 'ready', playerIds: input.playerIds, deltas: input.deltas };
  }

  if (input.treasuryHandle.trim().length === 0) {
    return { kind: 'invalid', reason: 'configured treasury handle is empty' };
  }

  const treasury = await input.findByHandle(input.treasuryHandle);
  if (treasury === null) {
    return {
      kind: 'invalid',
      reason: `configured treasury handle "${input.treasuryHandle}" has no players row`,
    };
  }
  if (treasury.chainAgentId === null) {
    return {
      kind: 'invalid',
      reason: `configured treasury handle "${input.treasuryHandle}" has no chain_agent_id`,
    };
  }
  if (input.playerIds.includes(treasury.id)) {
    return {
      kind: 'invalid',
      reason: `configured treasury handle "${input.treasuryHandle}" is already a playing player`,
    };
  }

  return {
    kind: 'ready',
    playerIds: [...input.playerIds, treasury.id],
    deltas: [...input.deltas, { agentId: treasury.id, delta: 0n }],
  };
}
