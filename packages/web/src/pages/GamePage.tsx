import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { getSpectatorPlugin } from '../games/registry';

// ---------------------------------------------------------------------------
// GamePage — game-agnostic wrapper that delegates to a SpectatorPlugin
// ---------------------------------------------------------------------------

export default function GamePage() {
  const { id } = useParams<{ id: string }>();
  const [perspective, setPerspective] = useState<'all' | 'A' | 'B'>('all');
  const [gameType, setGameType] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Fetch game type from server on mount
  useEffect(() => {
    if (!id) return;
    fetch(`/api/games/${id}`)
      .then(r => r.json())
      .then(data => {
        setGameType(data.gameType ?? 'capture-the-lobster');
        setLoading(false);
      })
      .catch(() => {
        // Default to CtL if fetch fails
        setGameType('capture-the-lobster');
        setLoading(false);
      });
  }, [id]);

  if (loading || !gameType) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-5rem)]">
        <div className="text-center">
          <p className="text-gray-400">Loading game...</p>
        </div>
      </div>
    );
  }

  const plugin = getSpectatorPlugin(gameType);

  if (!plugin) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-5rem)]">
        <div className="text-center">
          <p className="text-gray-400">Unknown game type: {gameType}</p>
        </div>
      </div>
    );
  }

  const SpectatorView = plugin.SpectatorView;

  return (
    <SpectatorView
      gameState={null}
      chatMessages={[]}
      handles={{}}
      gameId={id ?? ''}
      gameType={gameType}
      phase="in_progress"
      perspective={perspective}
      onPerspectiveChange={setPerspective}
    />
  );
}
