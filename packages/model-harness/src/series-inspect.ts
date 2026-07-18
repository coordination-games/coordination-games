import type { SeriesRawRelay } from './series-artifacts.js';

export type SeriesGameSnapshot = {
  readonly outcome: unknown;
  readonly standings: readonly { readonly playerId: string; readonly rank?: number }[];
  readonly relay: readonly SeriesRawRelay[];
};

export function extractSeriesGameSnapshot(value: unknown): SeriesGameSnapshot {
  const gameInspect = record(value)?.gameInspect;
  const inspect = record(gameInspect);
  if (!inspect) throw new Error('Inspector response omitted gameInspect');
  const state = record(inspect.gameState) ?? record(inspect.state);
  const replayChrome = record(inspect.replayChrome);
  const relay = Array.isArray(inspect.relayMessages)
    ? inspect.relayMessages
        .map(parseRelay)
        .filter((entry): entry is SeriesRawRelay => entry !== undefined)
    : [];
  return {
    outcome: {
      ...(typeof state?.phase === 'string' ? { phase: state.phase } : {}),
      ...(typeof replayChrome?.winnerLabel === 'string'
        ? { winnerLabel: replayChrome.winnerLabel }
        : {}),
    },
    standings: standings(inspect.standings),
    relay,
  };
}

function parseRelay(value: unknown): SeriesRawRelay | undefined {
  const relay = record(value);
  const scope = parseScope(relay?.scope);
  if (
    !relay ||
    scope === undefined ||
    typeof relay.index !== 'number' ||
    typeof relay.type !== 'string' ||
    typeof relay.pluginId !== 'string' ||
    typeof relay.sender !== 'string' ||
    (relay.turn !== null && typeof relay.turn !== 'number')
  ) {
    return undefined;
  }
  return {
    index: relay.index,
    type: relay.type,
    pluginId: relay.pluginId,
    sender: relay.sender,
    scope,
    turn: relay.turn,
    data: relay.data,
  };
}

function parseScope(value: unknown): SeriesRawRelay['scope'] | undefined {
  const scope = record(value);
  if (scope?.kind === 'all') return { kind: 'all' };
  if (scope?.kind === 'dm' && typeof scope.recipientHandle === 'string') {
    return { kind: 'dm', recipientHandle: scope.recipientHandle };
  }
  return undefined;
}

function standings(
  value: unknown,
): readonly { readonly playerId: string; readonly rank?: number }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const standing = record(entry);
    if (!standing || typeof standing.playerId !== 'string') return [];
    return [
      {
        playerId: standing.playerId,
        ...(typeof standing.rank === 'number' ? { rank: standing.rank } : {}),
      },
    ];
  });
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return Object.fromEntries(Object.entries(value));
}
