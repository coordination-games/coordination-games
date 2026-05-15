import type { SpectatorViewProps } from '../types';
import { OriginalObservatory } from './original/OriginalObservatory';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasRenderableState(source: unknown): boolean {
  const candidate = renderableState(source);
  if (!isRecord(candidate)) return false;
  const hasLegacyBoard = Array.isArray(candidate.boardTiles);
  const hasV2Board =
    Array.isArray(candidate.tiles) &&
    Array.isArray(candidate.intersections) &&
    Array.isArray(candidate.structures) &&
    Array.isArray(candidate.roads);
  return (
    Array.isArray(candidate.players) &&
    Array.isArray(candidate.ecosystems) &&
    (hasLegacyBoard || hasV2Board)
  );
}

function renderableState(source: unknown): Record<string, unknown> | null {
  if (!isRecord(source)) return null;
  const candidate = source.type === 'state_update' ? source.state : (source.data ?? source);
  return isRecord(candidate) ? candidate : null;
}

function setupPlayerLabel(
  state: Record<string, unknown>,
  handles: Record<string, string>,
): string | null {
  if (state.phase !== 'waiting') return null;
  const players = Array.isArray(state.players) ? state.players : [];
  const index = typeof state.currentPlayerIndex === 'number' ? state.currentPlayerIndex : -1;
  const player = players[index];
  if (!isRecord(player) || typeof player.id !== 'string') return null;
  return handles[player.id] ?? player.id;
}

export function TragedyOfTheCommonsSpectatorView(props: SpectatorViewProps) {
  const { handles, gameId, gameState, liveSnapshot, liveIsLive, liveError, replaySnapshots } =
    props;
  const isReplay = replaySnapshots != null;
  const source = (isReplay ? gameState : liveSnapshot) ?? gameState;
  const state = renderableState(source);
  const setupPlayer = state ? setupPlayerLabel(state, handles) : null;

  if (!hasRenderableState(source)) {
    return (
      <div className="flex min-h-[420px] items-center justify-center p-8">
        <div className="parchment-strong max-w-md rounded-2xl p-8 text-center shadow-lg">
          <div className="mb-3 text-4xl">🌾</div>
          <h2 className="font-heading text-xl tracking-wide">Tragedy of the Commons</h2>
          <p className="mt-3 text-sm" style={{ color: 'var(--color-ink-light)' }}>
            {liveError ?? 'Waiting for commons telemetry...'}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full">
      {setupPlayer ? (
        <div className="mx-auto mb-4 max-w-5xl rounded-2xl border border-amber-400/30 bg-amber-100/40 px-4 py-3 text-sm shadow-sm">
          <span className="font-heading tracking-wide" style={{ color: 'var(--color-forest)' }}>
            Setup in progress
          </span>{' '}
          <span style={{ color: 'var(--color-ink-light)' }}>
            Waiting for {setupPlayer} to place a starting camp.
          </span>
        </div>
      ) : null}
      <OriginalObservatory
        gameId={gameId}
        source={source}
        handles={handles}
        isLive={liveIsLive ?? false}
      />
    </div>
  );
}
