import type { GeniusState, GeniusVisibleState } from './types.js';

export function buildGeniusVisibleState(state: GeniusState): GeniusVisibleState {
  return {
    phase: state.phase,
    round: state.round,
    maxRounds: state.maxRounds,
    sequence: [...state.sequence],
    currentPlayerId: state.currentPlayerId,
    inputIndex: state.inputIndex,
    completedThisRound: [...state.completedThisRound],
    players: state.players.map((player) => ({ ...player })),
    winnerIds: [...state.winnerIds],
  };
}

export function geniusSummary(state: GeniusVisibleState): Record<string, unknown> {
  return {
    phase: state.phase,
    round: state.round,
    maxRounds: state.maxRounds,
    players: state.players.map((player) => player.id),
    winnerIds: [...state.winnerIds],
  };
}

function snapshotRecord(snapshot: unknown): Record<string, unknown> {
  if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new TypeError('Genius spectator snapshot must be an object');
  }
  return Object.fromEntries(Object.entries(snapshot));
}

export function geniusSummaryFromSnapshot(snapshot: unknown): Record<string, unknown> {
  const record = snapshotRecord(snapshot);
  const players = Array.isArray(record.players)
    ? record.players.flatMap((player) => {
        if (player === null || typeof player !== 'object' || Array.isArray(player)) return [];
        const item = Object.fromEntries(Object.entries(player));
        return typeof item.id === 'string' ? [item.id] : [];
      })
    : [];
  const winnerIds = Array.isArray(record.winnerIds)
    ? record.winnerIds.filter((winner): winner is string => typeof winner === 'string')
    : [];
  return {
    phase: record.phase,
    round: record.round,
    maxRounds: record.maxRounds,
    players,
    winnerIds,
  };
}

export function geniusReplayChrome(snapshot: unknown): {
  readonly isFinished: boolean;
  readonly winnerLabel?: string;
  readonly statusVariant: 'in_progress' | 'win' | 'draw';
} {
  const record = snapshotRecord(snapshot);
  if (record.phase !== 'finished') return { isFinished: false, statusVariant: 'in_progress' };
  const winnerIds = Array.isArray(record.winnerIds)
    ? record.winnerIds.filter((winner): winner is string => typeof winner === 'string')
    : [];
  if (winnerIds.length !== 1) return { isFinished: true, statusVariant: 'draw' };
  const winnerLabel = winnerIds[0];
  return winnerLabel === undefined
    ? { isFinished: true, statusVariant: 'draw' }
    : { isFinished: true, winnerLabel, statusVariant: 'win' };
}
