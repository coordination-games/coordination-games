// Runtime parser for the TournamentDO public `/state` payload.
//
// The Durable Object serializes bigints as strings and exposes ONLY public
// fields. This parser re-validates that contract at the network boundary
// (parse, don't validate) and deliberately drops anything outside the
// allow-list, so a future backend leak of a secret/root-seed/entropy/endpoint
// field can never reach the view layer.

export type TournamentStatus = 'running' | 'completed' | 'failed';

export interface Standing {
  readonly playerId: string;
  readonly cumulativeDelta: string;
  readonly gamesPlayed: number;
}

export interface Policy {
  readonly baseEntryCost: string;
  readonly carryBps: string;
  readonly slashBps: string;
}

export interface Economics {
  readonly baseEntryCost: string;
  readonly entryCost: string;
  readonly playerCount: number;
  readonly basePot: string;
  readonly incomingCarry: string;
  readonly releasedCarry: string;
  readonly carryRemainder: string;
  readonly carry: string;
  readonly slash: string;
  readonly treasuryDelta: string;
}

export interface Settlement {
  readonly gameId: string;
  readonly gameIndex: number;
  readonly txHash: string;
  readonly blockNumber: number;
  readonly entryCost: string;
  readonly carry: string;
  readonly slash: string;
  readonly treasuryDelta: string;
}

export interface TournamentState {
  readonly tournamentId: string;
  readonly gameType: string;
  readonly standings: readonly Standing[];
  readonly activePlayerIds: readonly string[];
  readonly eliminatedPlayerIds: readonly string[];
  readonly currentGameId: string | null;
  readonly currentGameIndex: number | null;
  readonly gameIds: readonly string[];
  readonly policy: Policy;
  readonly treasuryCarry: string;
  readonly currentEconomics: Economics | null;
  readonly lastSettlement: Settlement | null;
  readonly status: TournamentStatus;
}

export class TournamentParseError extends Error {
  constructor(
    readonly field: string,
    readonly reason: string,
  ) {
    super(`tournament state field "${field}": ${reason}`);
    this.name = 'TournamentParseError';
  }
}

type Obj = Record<string, unknown>;

function obj(value: unknown, field: string): Obj {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TournamentParseError(field, 'expected an object');
  }
  return value as Obj;
}

function str(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new TournamentParseError(field, 'expected a string');
  return value;
}

function num(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TournamentParseError(field, 'expected a finite number');
  }
  return value;
}

function intOrNull(value: unknown, field: string): number | null {
  return value === null ? null : num(value, field);
}

function strOrNull(value: unknown, field: string): string | null {
  return value === null ? null : str(value, field);
}

function strArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value)) throw new TournamentParseError(field, 'expected an array');
  return value.map((entry, i) => str(entry, `${field}[${i}]`));
}

function parseStatus(value: unknown): TournamentStatus {
  const s = str(value, 'status');
  if (s === 'running' || s === 'completed' || s === 'failed') return s;
  throw new TournamentParseError('status', `unknown status "${s}"`);
}

function parseStanding(value: unknown, field: string): Standing {
  const o = obj(value, field);
  return {
    playerId: str(o.playerId, `${field}.playerId`),
    cumulativeDelta: str(o.cumulativeDelta, `${field}.cumulativeDelta`),
    gamesPlayed: num(o.gamesPlayed, `${field}.gamesPlayed`),
  };
}

function parsePolicy(value: unknown): Policy {
  const o = obj(value, 'policy');
  return {
    baseEntryCost: str(o.baseEntryCost, 'policy.baseEntryCost'),
    carryBps: str(o.carryBps, 'policy.carryBps'),
    slashBps: str(o.slashBps, 'policy.slashBps'),
  };
}

function parseEconomics(value: unknown): Economics | null {
  if (value === null) return null;
  const o = obj(value, 'currentEconomics');
  return {
    baseEntryCost: str(o.baseEntryCost, 'currentEconomics.baseEntryCost'),
    entryCost: str(o.entryCost, 'currentEconomics.entryCost'),
    playerCount: num(o.playerCount, 'currentEconomics.playerCount'),
    basePot: str(o.basePot, 'currentEconomics.basePot'),
    incomingCarry: str(o.incomingCarry, 'currentEconomics.incomingCarry'),
    releasedCarry: str(o.releasedCarry, 'currentEconomics.releasedCarry'),
    carryRemainder: str(o.carryRemainder, 'currentEconomics.carryRemainder'),
    carry: str(o.carry, 'currentEconomics.carry'),
    slash: str(o.slash, 'currentEconomics.slash'),
    treasuryDelta: str(o.treasuryDelta, 'currentEconomics.treasuryDelta'),
  };
}

function parseSettlement(value: unknown): Settlement | null {
  if (value === null) return null;
  const o = obj(value, 'lastSettlement');
  return {
    gameId: str(o.gameId, 'lastSettlement.gameId'),
    gameIndex: num(o.gameIndex, 'lastSettlement.gameIndex'),
    txHash: str(o.txHash, 'lastSettlement.txHash'),
    blockNumber: num(o.blockNumber, 'lastSettlement.blockNumber'),
    entryCost: str(o.entryCost, 'lastSettlement.entryCost'),
    carry: str(o.carry, 'lastSettlement.carry'),
    slash: str(o.slash, 'lastSettlement.slash'),
    treasuryDelta: str(o.treasuryDelta, 'lastSettlement.treasuryDelta'),
  };
}

/**
 * Parse an untrusted `/state` payload into a typed TournamentState, or throw
 * TournamentParseError. Only allow-listed fields are read; everything else
 * (including any future private field) is ignored by construction.
 */
export function parseTournamentState(raw: unknown): TournamentState {
  const o = obj(raw, 'state');
  return {
    tournamentId: str(o.tournamentId, 'tournamentId'),
    gameType: str(o.gameType, 'gameType'),
    standings: Array.isArray(o.standings)
      ? o.standings.map((s, i) => parseStanding(s, `standings[${i}]`))
      : (() => {
          throw new TournamentParseError('standings', 'expected an array');
        })(),
    activePlayerIds: strArray(o.activePlayerIds, 'activePlayerIds'),
    eliminatedPlayerIds: strArray(o.eliminatedPlayerIds, 'eliminatedPlayerIds'),
    currentGameId: strOrNull(o.currentGameId, 'currentGameId'),
    currentGameIndex: intOrNull(o.currentGameIndex, 'currentGameIndex'),
    gameIds: strArray(o.gameIds, 'gameIds'),
    policy: parsePolicy(o.policy),
    treasuryCarry: str(o.treasuryCarry, 'treasuryCarry'),
    currentEconomics: parseEconomics(o.currentEconomics ?? null),
    lastSettlement: parseSettlement(o.lastSettlement ?? null),
    status: parseStatus(o.status),
  };
}
