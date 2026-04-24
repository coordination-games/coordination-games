import { useEffect, useState } from 'react';
import { callPlugin } from '../lib/plugin-call';

interface Player {
  handle: string;
  elo: number;
  gamesPlayed: number;
  wins: number;
}

function rankColor(rank: number): string {
  if (rank === 1) return 'var(--color-mint)';
  if (rank === 2) return 'var(--color-mint-deep)';
  if (rank === 3) return 'var(--color-graphite)';
  return 'var(--color-ash)';
}

export default function LeaderboardPage() {
  const [players, setPlayers] = useState<Player[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const data = await callPlugin<Player[]>('elo', 'leaderboard', { limit: 50 });
        if (!cancelled) setPlayers(data);
      } catch {}
      if (!cancelled) setLoading(false);
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  const sorted = [...players].sort((a, b) => b.elo - a.elo);

  return (
    <div className="space-y-6">
      {/* Section eyebrow */}
      <div className="flex items-center gap-3">
        <span
          className="font-mono text-[11px] tracking-[0.22em] uppercase"
          style={{ color: 'var(--color-ash)' }}
        >
          02
        </span>
        <span
          className="font-mono text-[11px] tracking-[0.22em] uppercase"
          style={{ color: 'var(--color-warm-black)' }}
        >
          Leaderboard
        </span>
        <div className="flex-1 hairline" />
      </div>

      <div>
        <h1
          className="font-display text-4xl sm:text-5xl font-medium tracking-tight leading-tight"
          style={{ color: 'var(--color-warm-black)' }}
        >
          Steady hands.
          <br />
          <span style={{ color: 'var(--color-mint-deep)' }}>Sharper teams.</span>
        </h1>
        <p
          className="mt-3 font-editorial italic text-base max-w-xl"
          style={{ color: 'var(--color-graphite)' }}
        >
          ELO across all matches. Pitch your tools, prove the coordination.
        </p>
      </div>

      {loading ? (
        <div className="py-16 text-center" style={{ border: '1px dashed var(--color-stone)' }}>
          <p
            className="font-mono text-[11px] tracking-[0.22em] uppercase"
            style={{ color: 'var(--color-ash)' }}
          >
            <span style={{ color: 'var(--color-mint-deep)' }}>{'// '}</span>
            Loading…
          </p>
        </div>
      ) : sorted.length === 0 ? (
        <div className="py-16 text-center" style={{ border: '1px dashed var(--color-stone)' }}>
          <p
            className="font-mono text-[11px] tracking-[0.22em] uppercase"
            style={{ color: 'var(--color-ash)' }}
          >
            <span style={{ color: 'var(--color-mint-deep)' }}>{'// '}</span>
            No data yet
          </p>
          <p
            className="font-editorial italic text-sm mt-3"
            style={{ color: 'var(--color-graphite)' }}
          >
            Play a match to seed the leaderboard.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto" style={{ border: '1px solid rgba(28,26,23,0.1)' }}>
          <table className="w-full text-sm">
            <thead>
              <tr
                className="text-left font-mono text-[10px] uppercase tracking-[0.18em]"
                style={{
                  borderBottom: '1px solid rgba(28,26,23,0.12)',
                  color: 'var(--color-ash)',
                  background: 'var(--color-bone)',
                }}
              >
                <th className="px-3 sm:px-5 py-3 w-12 sm:w-16">Rank</th>
                <th className="px-3 sm:px-5 py-3">Handle</th>
                <th className="px-3 sm:px-5 py-3 text-right">ELO</th>
                <th className="hidden sm:table-cell px-5 py-3 text-right">Games</th>
                <th className="hidden sm:table-cell px-5 py-3 text-right">Wins</th>
                <th className="px-3 sm:px-5 py-3 text-right">W%</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((player, i) => {
                const rank = i + 1;
                const winRate =
                  player.gamesPlayed > 0 ? Math.round((player.wins / player.gamesPlayed) * 100) : 0;
                return (
                  <tr
                    key={player.handle}
                    className="transition-colors hover:bg-[rgba(2,226,172,0.04)]"
                    style={{
                      borderBottom: '1px solid rgba(28,26,23,0.06)',
                      background: 'var(--color-bone)',
                    }}
                  >
                    <td
                      className="px-3 sm:px-5 py-3 font-mono text-[12px] font-medium"
                      style={{ color: rankColor(rank) }}
                    >
                      {String(rank).padStart(2, '0')}
                    </td>
                    <td className="px-3 sm:px-5 py-3">
                      <span
                        className="font-mono text-xs sm:text-sm"
                        style={{ color: 'var(--color-warm-black)' }}
                      >
                        {rank === 1 && (
                          <span
                            className="inline-block w-1.5 h-1.5 rounded-full mr-2 align-middle"
                            style={{ background: 'var(--color-mint)' }}
                          />
                        )}
                        {player.handle}
                      </span>
                    </td>
                    <td
                      className="px-3 sm:px-5 py-3 text-right font-display text-base font-medium"
                      style={{
                        color: rank <= 3 ? 'var(--color-mint-deep)' : 'var(--color-warm-black)',
                      }}
                    >
                      {player.elo}
                    </td>
                    <td
                      className="hidden sm:table-cell px-5 py-3 text-right font-mono text-xs"
                      style={{ color: 'var(--color-graphite)' }}
                    >
                      {player.gamesPlayed}
                    </td>
                    <td
                      className="hidden sm:table-cell px-5 py-3 text-right font-mono text-xs"
                      style={{ color: 'var(--color-graphite)' }}
                    >
                      {player.wins}
                    </td>
                    <td
                      className="px-3 sm:px-5 py-3 text-right font-mono text-xs"
                      style={{
                        color: winRate >= 50 ? 'var(--color-mint-deep)' : 'var(--color-hot-deep)',
                      }}
                    >
                      {winRate}%
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
