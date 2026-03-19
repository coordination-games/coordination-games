import { useEffect, useState } from 'react';
import { fetchLeaderboard } from '../api';

interface Player {
  handle: string;
  elo: number;
  gamesPlayed: number;
  wins: number;
}

const mockPlayers: Player[] = [];

function rankDecoration(rank: number) {
  switch (rank) {
    case 1:
      return 'text-yellow-400 font-bold';
    case 2:
      return 'text-gray-300 font-bold';
    case 3:
      return 'text-amber-600 font-bold';
    default:
      return 'text-gray-500';
  }
}

function eloColor(rank: number) {
  if (rank <= 3) return 'text-yellow-400';
  return 'text-gray-100';
}

function winRateColor(rate: number) {
  if (rate >= 50) return 'text-green-400';
  return 'text-red-400';
}

export default function LeaderboardPage() {
  const [players, setPlayers] = useState<Player[]>(mockPlayers);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const data = await fetchLeaderboard();
        if (!cancelled) setPlayers(data as Player[]);
      } catch {
        // API not available yet — keep mock data
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, []);

  const sorted = [...players].sort((a, b) => b.elo - a.elo);

  return (
    <div>
      <h2 className="mb-6 text-2xl font-bold text-gray-100">Leaderboard</h2>

      <div className="overflow-x-auto rounded-lg border border-gray-800">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-800 bg-gray-900 text-left text-xs uppercase tracking-wider text-gray-500">
              <th className="px-5 py-3 w-16">#</th>
              <th className="px-5 py-3">Handle</th>
              <th className="px-5 py-3 text-right">ELO</th>
              <th className="px-5 py-3 text-right">Games</th>
              <th className="px-5 py-3 text-right">Wins</th>
              <th className="px-5 py-3 text-right">Win Rate</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((player, i) => {
              const rank = i + 1;
              const winRate = player.gamesPlayed > 0
                ? Math.round((player.wins / player.gamesPlayed) * 100)
                : 0;

              return (
                <tr
                  key={player.handle}
                  className={`border-b border-gray-800/50 transition-colors hover:bg-gray-800/40 ${
                    rank % 2 === 0 ? 'bg-gray-900/30' : ''
                  }`}
                >
                  {/* Rank */}
                  <td className={`px-5 py-3 ${rankDecoration(rank)}`}>
                    {rank}
                  </td>

                  {/* Handle */}
                  <td className="px-5 py-3">
                    <span className="font-mono text-gray-200">
                      {rank === 1 && <span className="mr-1.5">{'\u{1F99E}'}</span>}
                      {player.handle}
                    </span>
                  </td>

                  {/* ELO */}
                  <td className={`px-5 py-3 text-right text-base font-bold ${eloColor(rank)}`}>
                    {player.elo}
                  </td>

                  {/* Games Played */}
                  <td className="px-5 py-3 text-right text-gray-400">
                    {player.gamesPlayed}
                  </td>

                  {/* Wins */}
                  <td className="px-5 py-3 text-right text-gray-400">
                    {player.wins}
                  </td>

                  {/* Win Rate */}
                  <td className={`px-5 py-3 text-right font-medium ${winRateColor(winRate)}`}>
                    {winRate}%
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
