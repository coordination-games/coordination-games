import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { TragedyV2Action } from './types.js';

const campIds = ['northWest', 'north', 'south'] as const;
const passActionSchema = z.object({ type: z.literal('pass') }).strict();
const policySchema = z
  .object({
    botName: z.enum(['mint-mediator', 'ash-builder', 'hot-opportunist']),
    model: z.string().regex(/minimax/i, 'model must identify MiniMax'),
    persona: z.string().min(1).max(280),
    setup: z.object({ startingCamp: z.enum(campIds) }).strict(),
    roundRule: z.object({ action: passActionSchema }).strict(),
  })
  .strict();

export type TournamentDemoPolicy = Readonly<
  z.infer<typeof policySchema> & {
    readonly sourcePath: string;
    readonly sha256: string;
  }
>;

export class TournamentDemoPolicyError extends Error {
  readonly name = 'TournamentDemoPolicyError';

  constructor(
    readonly sourcePath: string,
    readonly reason: string,
  ) {
    super(`Invalid tournament demo policy ${sourcePath}: ${reason}`);
  }
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function parseTournamentDemoPolicy(
  value: unknown,
  sourcePath: string,
  sourceText = JSON.stringify(value),
): TournamentDemoPolicy {
  const parsed = policySchema.safeParse(value);
  if (!parsed.success) {
    throw new TournamentDemoPolicyError(
      sourcePath,
      parsed.error.issues[0]?.message ?? 'invalid policy',
    );
  }
  return Object.freeze({ ...parsed.data, sourcePath, sha256: digest(sourceText) });
}

export function evaluateTournamentDemoSetup(policy: TournamentDemoPolicy): TragedyV2Action {
  return { type: 'place_starting_camp', intersectionId: policy.setup.startingCamp };
}

export function evaluateTournamentDemoRound(policy: TournamentDemoPolicy): TragedyV2Action {
  return policy.roundRule.action;
}
