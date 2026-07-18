import type { TournamentStanding, TournamentState } from './tournament-orchestration.js';

export function parseTournamentState(value: unknown): TournamentState {
  const record = asRecord(value);
  if (!record) throw new Error('Tournament state was not an object');
  const status = record.status;
  if (status !== 'running' && status !== 'completed' && status !== 'failed') {
    throw new Error('Tournament state omitted a supported status');
  }
  const currentGameId = typeof record.currentGameId === 'string' ? record.currentGameId : null;
  const activePlayerIds = strings(record.activePlayerIds);
  const gameIds = strings(record.gameIds);
  const standings = Array.isArray(record.standings)
    ? record.standings.flatMap(parseStanding)
    : undefined;
  return {
    status,
    currentGameId,
    activePlayerIds,
    gameIds,
    ...(standings ? { standings } : {}),
    ...(typeof record.error === 'string' ? { error: record.error } : {}),
  };
}

function parseStanding(value: unknown): readonly TournamentStanding[] {
  const record = asRecord(value);
  if (!record || typeof record.playerId !== 'string') return [];
  return [
    {
      playerId: record.playerId,
      ...(typeof record.rank === 'number' ? { rank: record.rank } : {}),
      ...(typeof record.cumulativeDelta === 'string'
        ? { cumulativeDelta: record.cumulativeDelta }
        : {}),
    },
  ];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function strings(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
