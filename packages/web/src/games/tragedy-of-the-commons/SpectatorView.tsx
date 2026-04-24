import type { SpectatorViewProps } from '../types';

interface TragedyPlayer {
  id: string;
  vp: number;
  influence: number;
  totalResources: number;
  regionsControlled: string[];
}

interface TragedyEcosystem {
  id: string;
  name: string;
  resource: string;
  health: number;
  maxHealth: number;
  status: 'flourishing' | 'stable' | 'strained' | 'collapsed';
}

interface TragedySpectatorState {
  round: number;
  maxRounds: number;
  phase: 'waiting' | 'playing' | 'finished';
  players: TragedyPlayer[];
  ecosystems: TragedyEcosystem[];
  activeTrades: unknown[];
  winner: string | null;
}

function mapServerState(raw: unknown): TragedySpectatorState | null {
  if (!raw || typeof raw !== 'object') return null;
  const top = raw as { data?: unknown; state?: unknown; type?: string };
  const candidate = top.type === 'state_update' ? top.state : (top.data ?? raw);
  if (!candidate || typeof candidate !== 'object') return null;
  const data = candidate as Partial<TragedySpectatorState>;
  if (!Array.isArray(data.players) || !Array.isArray(data.ecosystems)) return null;
  return {
    round: data.round ?? 0,
    maxRounds: data.maxRounds ?? 12,
    phase: data.phase ?? 'waiting',
    players: data.players,
    ecosystems: data.ecosystems,
    activeTrades: data.activeTrades ?? [],
    winner: data.winner ?? null,
  };
}

function statusColor(status: TragedyEcosystem['status']): string {
  switch (status) {
    case 'flourishing':
      return '#4ade80';
    case 'stable':
      return '#e9d852';
    case 'strained':
      return '#fb923c';
    case 'collapsed':
      return '#ef4444';
  }
}

function comparePlayerId(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function TragedyOfTheCommonsSpectatorView(props: SpectatorViewProps) {
  const { handles, gameState, liveSnapshot, liveError, replaySnapshots } = props;
  const isReplay = replaySnapshots != null;
  const state = mapServerState(isReplay ? gameState : liveSnapshot) ?? mapServerState(gameState);

  if (!state) {
    return (
      <div
        className="flex h-full items-center justify-center p-8"
        style={{ color: 'var(--color-ink)' }}
      >
        <div className="max-w-md rounded-2xl parchment-strong p-8 text-center shadow-lg">
          <div className="mb-3 text-4xl">🌾</div>
          <h2 className="font-heading text-xl tracking-wide">Tragedy of the Commons</h2>
          <p className="mt-3 text-sm" style={{ color: 'var(--color-ink-light)' }}>
            {liveError ?? 'Waiting for commons telemetry...'}
          </p>
        </div>
      </div>
    );
  }

  const sortedPlayers = [...state.players].sort((left, right) => {
    if (right.vp !== left.vp) return right.vp - left.vp;
    if (right.influence !== left.influence) return right.influence - left.influence;
    return comparePlayerId(left.id, right.id);
  });
  const progress = state.maxRounds > 0 ? Math.round((state.round / state.maxRounds) * 100) : 0;

  return (
    <div className="h-full overflow-auto p-6" style={{ color: 'var(--color-ink)' }}>
      <div className="mx-auto flex max-w-6xl flex-col gap-6">
        <section className="rounded-2xl parchment-strong p-6 shadow-lg">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p
                className="font-mono text-xs uppercase tracking-[0.35em]"
                style={{ color: 'var(--color-amber)' }}
              >
                Commons pressure report
              </p>
              <h1 className="mt-2 font-heading text-3xl">Tragedy of the Commons</h1>
              <p className="mt-2 text-sm" style={{ color: 'var(--color-ink-light)' }}>
                Round {state.round}/{state.maxRounds} ·{' '}
                {state.phase === 'finished' ? 'Finished' : 'Shared resources still contested'}
              </p>
            </div>
            <div
              className="min-w-48 rounded-xl p-4"
              style={{ background: 'rgba(42, 31, 14, 0.06)' }}
            >
              <div
                className="mb-2 flex justify-between font-mono text-xs"
                style={{ color: 'var(--color-ink-faint)' }}
              >
                <span>Progress</span>
                <span>{progress}%</span>
              </div>
              <div className="h-2 rounded-full" style={{ background: 'rgba(42, 31, 14, 0.1)' }}>
                <div
                  className="h-2 rounded-full transition-all"
                  style={{
                    width: `${progress}%`,
                    background: 'linear-gradient(90deg, #4ade80, #e9d852, #ef4444)',
                  }}
                />
              </div>
            </div>
          </div>
        </section>

        {state.phase === 'finished' ? (
          <section className="rounded-2xl parchment-strong p-6 text-center shadow-lg">
            <p
              className="font-mono text-xs uppercase tracking-[0.35em]"
              style={{ color: 'var(--color-amber)' }}
            >
              Final settlement
            </p>
            <h2 className="mt-2 font-heading text-2xl">
              {state.winner
                ? `${handles[state.winner] ?? state.winner} wins the commons`
                : 'The commons ends in a draw'}
            </h2>
          </section>
        ) : null}

        <div className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
          <section className="rounded-2xl parchment-strong p-6 shadow-lg">
            <h2 className="font-heading text-xl">Ecosystems</h2>
            <div className="mt-4 grid gap-4">
              {state.ecosystems.map((ecosystem) => {
                const healthPct =
                  ecosystem.maxHealth > 0
                    ? Math.round((ecosystem.health / ecosystem.maxHealth) * 100)
                    : 0;
                return (
                  <div
                    key={ecosystem.id}
                    className="rounded-xl p-4"
                    style={{ background: 'rgba(255,255,255,0.28)' }}
                  >
                    <div className="flex justify-between gap-3">
                      <div>
                        <h3 className="font-heading text-base">{ecosystem.name}</h3>
                        <p
                          className="font-mono text-xs uppercase"
                          style={{ color: 'var(--color-ink-faint)' }}
                        >
                          {ecosystem.resource} · {ecosystem.status}
                        </p>
                      </div>
                      <span
                        className="font-mono text-sm"
                        style={{ color: statusColor(ecosystem.status) }}
                      >
                        {ecosystem.health}/{ecosystem.maxHealth}
                      </span>
                    </div>
                    <div
                      className="mt-3 h-2 rounded-full"
                      style={{ background: 'rgba(42, 31, 14, 0.1)' }}
                    >
                      <div
                        className="h-2 rounded-full transition-all"
                        style={{
                          width: `${healthPct}%`,
                          background: statusColor(ecosystem.status),
                        }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          <section className="rounded-2xl parchment-strong p-6 shadow-lg">
            <h2 className="font-heading text-xl">Players</h2>
            <div className="mt-4 grid gap-3">
              {sortedPlayers.map((player, index) => (
                <div
                  key={player.id}
                  className="rounded-xl p-4"
                  style={{ background: 'rgba(255,255,255,0.28)' }}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="font-heading text-base">
                        #{index + 1} {handles[player.id] ?? player.id}
                      </p>
                      <p className="font-mono text-xs" style={{ color: 'var(--color-ink-faint)' }}>
                        {player.regionsControlled.length} regions · {player.totalResources}{' '}
                        resources
                      </p>
                    </div>
                    <div className="text-right font-mono text-sm">
                      <div>{player.vp} VP</div>
                      <div style={{ color: 'var(--color-ink-faint)' }}>{player.influence} INF</div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>

        {state.activeTrades.length > 0 ? (
          <section className="rounded-2xl parchment-strong p-6 shadow-lg">
            <h2 className="font-heading text-xl">Settled trades this round</h2>
            <p className="mt-2 text-sm" style={{ color: 'var(--color-ink-light)' }}>
              {state.activeTrades.length} reciprocal trade offers resolved.
            </p>
          </section>
        ) : null}
      </div>
    </div>
  );
}
