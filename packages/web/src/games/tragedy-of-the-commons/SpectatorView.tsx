import type { SpectatorViewProps } from '../types';
import { OriginalObservatory } from './original/OriginalObservatory';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasRenderableState(source: unknown): boolean {
  if (!isRecord(source)) return false;
  const candidate = source.type === 'state_update' ? source.state : (source.data ?? source);
  if (!isRecord(candidate)) return false;
  return (
    Array.isArray(candidate.players) &&
    Array.isArray(candidate.ecosystems) &&
    Array.isArray(candidate.regions) &&
    Array.isArray(candidate.boardTiles)
  );
}

export function TragedyOfTheCommonsSpectatorView(props: SpectatorViewProps) {
  const { handles, gameId, gameState, liveSnapshot, liveIsLive, liveError, replaySnapshots } =
    props;
  const isReplay = replaySnapshots != null;
  const source = (isReplay ? gameState : liveSnapshot) ?? gameState;

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
      <OriginalObservatory
        gameId={gameId}
        source={source}
        handles={handles}
        isLive={liveIsLive ?? false}
      />
    </div>
  );
}
