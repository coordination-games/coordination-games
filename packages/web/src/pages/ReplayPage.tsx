import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { fetchReplay } from '../api';
import type { ReplayData } from '../api';
import { getSpectatorPlugin } from '../games/registry';

// ---------------------------------------------------------------------------
// ReplayPage — generic replay shell for any game type
// ---------------------------------------------------------------------------

export default function ReplayPage() {
  const { id } = useParams<{ id: string }>();
  const [currentTurn, setCurrentTurn] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const playIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

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

  // Resolve the spectator plugin for this game type
  const plugin = replay ? getSpectatorPlugin(replay.gameType) : null;

  // Auto-play logic
  useEffect(() => {
    if (isPlaying && totalTurns > 0) {
      playIntervalRef.current = setInterval(() => {
        setCurrentTurn((prev) => {
          if (prev >= totalTurns - 1) {
            setIsPlaying(false);
            return prev;
          }
          return prev + 1;
        });
      }, 1500);
    } else {
      if (playIntervalRef.current) {
        clearInterval(playIntervalRef.current);
        playIntervalRef.current = null;
      }
    }
    return () => {
      if (playIntervalRef.current) {
        clearInterval(playIntervalRef.current);
      }
    };
  }, [isPlaying, totalTurns]);

  // Navigation
  const goPrev = useCallback(() => {
    setIsPlaying(false);
    setCurrentTurn((prev) => Math.max(0, prev - 1));
  }, []);

  const goNext = useCallback(() => {
    setIsPlaying(false);
    setCurrentTurn((prev) => Math.min(totalTurns - 1, prev + 1));
  }, [totalTurns]);

  const togglePlay = useCallback(() => {
    setCurrentTurn((prev) => {
      if (prev >= totalTurns - 1) return 0;
      return prev;
    });
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

  if (error || !replay || totalTurns === 0) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-5rem)]">
        <div className="text-red-400 text-lg">
          {error ?? 'No replay data available for this game.'}
        </div>
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

  const isFinished = turnState.phase === 'finished' || turnState.winner;
  const winner = turnState.winner ?? null;

  return (
    <div className="flex flex-col h-[calc(100vh-5rem)] -mx-6 -my-8 px-4 py-3 gap-2">
      {/* Scrubber bar */}
      <ScrubberBar
        currentTurn={currentTurn}
        totalTurns={totalTurns}
        isPlaying={isPlaying}
        isFinished={!!isFinished}
        winner={winner}
        gameId={id ?? ''}
        gameType={plugin.displayName}
        onPrev={goPrev}
        onNext={goNext}
        onTogglePlay={togglePlay}
        onSeek={(t) => {
          setIsPlaying(false);
          setCurrentTurn(t);
        }}
      />

      {/* Game-specific rendering — fully delegated to the plugin */}
      <div className="flex-1 min-h-0">
        <plugin.SpectatorView
          gameState={turnState}
          chatMessages={[]}
          handles={replay.handles}
          gameId={id ?? ''}
          gameType={replay.gameType}
          phase={isFinished ? 'finished' : 'in_progress'}
          replaySnapshots={snapshots}
          replayIndex={currentTurn}
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
  winner,
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
  winner: string | null;
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
            {gameType} Replay{' '}
            <span className="font-mono text-emerald-400">{gameId}</span>
          </span>
          <span className="text-sm font-semibold text-gray-200">
            Turn {currentTurn}/{totalTurns - 1}
          </span>
        </div>

        {isFinished && winner && (
          <span className="text-sm font-bold px-3 py-1 rounded bg-emerald-800 text-emerald-200 animate-pulse">
            {winner} Wins!
          </span>
        )}
        {isFinished && !winner && (
          <span className="text-sm font-bold px-3 py-1 rounded bg-gray-700 text-gray-200">
            Draw!
          </span>
        )}
      </div>

      {/* Scrubber row */}
      <div className="flex items-center gap-3">
        <button
          onClick={onPrev}
          disabled={currentTurn === 0}
          className="px-2 py-1 text-sm rounded bg-gray-800 text-gray-300 hover:bg-gray-700 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          title="Previous turn (Left arrow)"
        >
          &#9664;
        </button>

        <button
          onClick={onNext}
          disabled={currentTurn >= totalTurns - 1}
          className="px-2 py-1 text-sm rounded bg-gray-800 text-gray-300 hover:bg-gray-700 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          title="Next turn (Right arrow)"
        >
          &#9654;
        </button>

        <button
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

        <input
          type="range"
          min={0}
          max={totalTurns - 1}
          value={currentTurn}
          onChange={(e) => onSeek(Number(e.target.value))}
          className="flex-1 h-2 rounded-lg appearance-none cursor-pointer bg-gray-700
            [&::-webkit-slider-thumb]:appearance-none
            [&::-webkit-slider-thumb]:w-4
            [&::-webkit-slider-thumb]:h-4
            [&::-webkit-slider-thumb]:rounded-full
            [&::-webkit-slider-thumb]:bg-emerald-500
            [&::-webkit-slider-thumb]:hover:bg-emerald-400
            [&::-webkit-slider-thumb]:transition-colors
            [&::-moz-range-thumb]:w-4
            [&::-moz-range-thumb]:h-4
            [&::-moz-range-thumb]:rounded-full
            [&::-moz-range-thumb]:bg-emerald-500
            [&::-moz-range-thumb]:border-0
            [&::-moz-range-thumb]:hover:bg-emerald-400"
        />

        <span className="text-xs text-gray-400 tabular-nums w-14 text-right shrink-0">
          {currentTurn}/{totalTurns - 1}
        </span>
      </div>
    </div>
  );
}
