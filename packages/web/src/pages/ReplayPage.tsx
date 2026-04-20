import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { ReplayData } from '../api';
import { fetchReplay } from '../api';
import { ScrubberSlider } from '../components/ScrubberSlider';
import { SpectatorPendingPlaceholder } from '../components/SpectatorPendingPlaceholder';
import { getSpectatorPlugin } from '../games/registry';

// ---------------------------------------------------------------------------
// ReplayPage — generic replay shell for any game type
// ---------------------------------------------------------------------------

export default function ReplayPage() {
  const { id } = useParams<{ id: string }>();
  const [currentTurn, setCurrentTurn] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  // Whether the current turn transition should animate (true during auto-play, false during scrubbing)
  const [animate, setAnimate] = useState(false);
  const playTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [replay, setReplay] = useState<ReplayData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Fetch replay data
  useEffect(() => {
    if (!id) return;
    setLoading(true);
    setError(null);
    fetchReplay(id)
      .then((data) => {
        setReplay(data);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message ?? 'Failed to load replay');
        setLoading(false);
      });
  }, [id]);

  const snapshots = replay?.snapshots ?? [];
  const totalTurns = snapshots.length;
  const turnState = snapshots[currentTurn] ?? null;
  const prevTurnState = currentTurn > 0 ? (snapshots[currentTurn - 1] ?? null) : null;

  // Resolve the spectator plugin for this game type
  const plugin = replay ? getSpectatorPlugin(replay.gameType) : null;

  // Animation duration from plugin (default 0 = instant transitions)
  const animationDuration = plugin?.animationDuration ?? 0;
  const playInterval = animationDuration + 700; // animation + read time

  // Auto-play logic — uses setTimeout chain so each turn waits for animations
  useEffect(() => {
    if (isPlaying && totalTurns > 0) {
      playTimeoutRef.current = setTimeout(() => {
        setCurrentTurn((prev) => {
          if (prev >= totalTurns - 1) {
            setIsPlaying(false);
            return prev;
          }
          setAnimate(true);
          return prev + 1;
        });
      }, playInterval);
    }
    return () => {
      if (playTimeoutRef.current) {
        clearTimeout(playTimeoutRef.current);
        playTimeoutRef.current = null;
      }
    };
  }, [isPlaying, totalTurns, playInterval]);

  // Navigation — scrubbing disables animation
  const goPrev = useCallback(() => {
    setIsPlaying(false);
    setAnimate(false);
    setCurrentTurn((prev) => Math.max(0, prev - 1));
  }, []);

  const goNext = useCallback(() => {
    setIsPlaying(false);
    setAnimate(false);
    setCurrentTurn((prev) => Math.min(totalTurns - 1, prev + 1));
  }, [totalTurns]);

  const togglePlay = useCallback(() => {
    setCurrentTurn((prev) => {
      if (prev >= totalTurns - 1) return 0;
      return prev;
    });
    setAnimate(true);
    setIsPlaying((prev) => !prev);
  }, [totalTurns]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        goPrev();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        goNext();
      } else if (e.key === ' ') {
        e.preventDefault();
        togglePlay();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [goPrev, goNext, togglePlay]);

  // Loading / error states
  if (loading) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-5rem)]">
        <div className="text-gray-400 text-lg">Loading replay...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-5rem)]">
        <div className="text-red-400 text-lg">{error}</div>
      </div>
    );
  }

  // Pre-window: no public snapshots yet.
  if (replay?.type === 'spectator_pending') {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-5rem)]">
        <SpectatorPendingPlaceholder title="Replay not yet available" />
      </div>
    );
  }

  if (!replay || totalTurns === 0) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-5rem)]">
        <div className="text-red-400 text-lg">No replay data available for this game.</div>
      </div>
    );
  }

  if (!turnState || !plugin) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-5rem)]">
        <div className="text-red-400 text-lg">
          No spectator plugin found for game type "{replay.gameType}".
        </div>
      </div>
    );
  }

  // Per-game chrome (finish badge, winner label) is owned by the plugin so
  // ReplayPage stays game-agnostic. Resolve playerId labels to handles when
  // available so OATH shows display names instead of UUIDs.
  const chrome = plugin.getReplayChrome(turnState);
  const winnerLabel = chrome.winnerLabel
    ? (replay.handles[chrome.winnerLabel] ?? chrome.winnerLabel)
    : null;

  return (
    <div className="flex flex-col h-[calc(100vh-5rem)] -mx-6 -my-8 px-4 py-3 gap-2">
      {/* Scrubber bar */}
      <ScrubberBar
        currentTurn={currentTurn}
        totalTurns={totalTurns}
        isPlaying={isPlaying}
        isFinished={chrome.isFinished}
        statusVariant={chrome.statusVariant}
        winnerLabel={winnerLabel}
        gameId={id ?? ''}
        gameType={plugin.displayName}
        onPrev={goPrev}
        onNext={goNext}
        onTogglePlay={togglePlay}
        onSeek={(t) => {
          setIsPlaying(false);
          setAnimate(false);
          setCurrentTurn(t);
        }}
      />

      {/* Game-specific rendering — fully delegated to the plugin */}
      <div className="flex-1 min-h-0">
        <plugin.SpectatorView
          gameState={turnState}
          prevGameState={prevTurnState}
          animate={animate}
          chatMessages={[]}
          handles={replay.handles}
          gameId={id ?? ''}
          gameType={replay.gameType}
          phase={chrome.isFinished ? 'finished' : 'in_progress'}
          replaySnapshots={snapshots}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ScrubberBar — generic, reusable across all game types
// ---------------------------------------------------------------------------

function ScrubberBar({
  currentTurn,
  totalTurns,
  isPlaying,
  isFinished,
  statusVariant,
  winnerLabel,
  gameId,
  gameType,
  onPrev,
  onNext,
  onTogglePlay,
  onSeek,
}: {
  currentTurn: number;
  totalTurns: number;
  isPlaying: boolean;
  isFinished: boolean;
  statusVariant: 'in_progress' | 'win' | 'draw';
  winnerLabel: string | null;
  gameId: string;
  gameType: string;
  onPrev: () => void;
  onNext: () => void;
  onTogglePlay: () => void;
  onSeek: (turn: number) => void;
}) {
  return (
    <div className="flex flex-col bg-gray-900 rounded-lg px-4 py-2 shrink-0 gap-2">
      {/* Title row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <span className="text-sm text-gray-400">
            {gameType} Replay <span className="font-mono text-emerald-400">{gameId}</span>
          </span>
          <span className="text-sm font-semibold text-gray-200">
            Turn {currentTurn}/{totalTurns - 1}
          </span>
        </div>

        {isFinished && statusVariant === 'win' && winnerLabel && (
          <span className="text-sm font-bold px-3 py-1 rounded bg-emerald-800 text-emerald-200 animate-pulse">
            {winnerLabel} Wins!
          </span>
        )}
        {isFinished && statusVariant === 'draw' && (
          <span className="text-sm font-bold px-3 py-1 rounded bg-gray-700 text-gray-200">
            Draw!
          </span>
        )}
      </div>

      {/* Scrubber row */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onTogglePlay}
          className={`px-3 py-1 text-sm rounded font-semibold transition-colors ${
            isPlaying
              ? 'bg-emerald-700 text-emerald-100 hover:bg-emerald-600'
              : 'bg-emerald-800 text-emerald-200 hover:bg-emerald-700'
          }`}
          title="Play/Pause (Space)"
        >
          {isPlaying ? 'Pause' : 'Play'}
        </button>
        <ScrubberSlider
          currentTurn={currentTurn}
          totalTurns={totalTurns}
          onPrev={onPrev}
          onNext={onNext}
          onSeek={onSeek}
        />
      </div>
    </div>
  );
}
