export type SeriesRelayScope =
  | { readonly kind: 'all' }
  | { readonly kind: 'dm'; readonly recipientHandle: string };

export type SeriesRelayEnvelope = {
  readonly gameId: string;
  readonly index: number;
  readonly type: string;
  readonly pluginId: string;
  readonly sender: string;
  readonly scope: SeriesRelayScope;
  readonly turn: number | null;
  readonly body?: string;
};

export type SeriesGameHistory = {
  readonly gameId: string;
  readonly outcome: {
    readonly phase?: string;
    readonly winnerLabel?: string;
  };
  readonly standings: readonly { readonly playerId: string; readonly rank?: number }[];
  readonly relay: readonly SeriesRelayEnvelope[];
};

export type SeriesContextInput = {
  readonly currentGameId: string;
  readonly viewerPlayerId: string;
  readonly viewerHandle?: string;
  readonly history: readonly SeriesGameHistory[];
};

export function buildSeriesContext(input: SeriesContextInput): string {
  const games = input.history.map((game) => ({
    gameId: game.gameId,
    outcome: game.outcome,
    standings: game.standings,
    relay: game.relay.filter((relay) =>
      isVisibleTo(relay, input.viewerPlayerId, input.viewerHandle),
    ),
  }));
  return `Tournament continuity for ${input.currentGameId}: ${JSON.stringify({ games })}`;
}

function isVisibleTo(
  envelope: SeriesRelayEnvelope,
  viewerPlayerId: string,
  viewerHandle: string | undefined,
): boolean {
  switch (envelope.scope.kind) {
    case 'all':
      return true;
    case 'dm':
      return (
        envelope.sender === viewerPlayerId ||
        envelope.scope.recipientHandle === viewerPlayerId ||
        envelope.scope.recipientHandle === viewerHandle
      );
    default: {
      const unreachable: never = envelope.scope;
      return unreachable;
    }
  }
}
