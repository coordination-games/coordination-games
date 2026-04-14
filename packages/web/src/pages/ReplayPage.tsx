import { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { fetchReplay } from '../api';
import type { ReplayData } from '../api';
import { getSpectatorPlugin } from '../games/registry';
import HexGrid from '../components/HexGrid';
import type { KillEvent, ChatMessage } from '../types';

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

const CLASS_ICONS: Record<string, string> = {
  rogue: 'R',
  knight: 'K',
  mage: 'M',
};

function KillFeed({ kills }: { kills: KillEvent[] }) {
  return (
    <div className="flex flex-col gap-1.5">
      {kills.length === 0 && (
        <p className="text-gray-600 text-xs italic">No kills yet</p>
      )}
      {[...kills].reverse().map((k, i) => {
        const killerColor =
          k.killerTeam === 'A' ? 'text-blue-400' : 'text-red-400';
        const victimColor =
          k.victimTeam === 'A' ? 'text-blue-400' : 'text-red-400';
        return (
          <div
            key={i}
            className="text-xs flex items-center gap-1 text-gray-300"
          >
            <span className="text-gray-500 w-6 text-right shrink-0">
              T{k.turn}
            </span>
            <span className={`font-bold ${killerColor}`}>
              {CLASS_ICONS[k.killerClass] ?? '?'}
            </span>
            <span className="text-gray-500">&rarr;</span>
            <span
              className={`font-bold ${victimColor} line-through opacity-60`}
            >
              {CLASS_ICONS[k.victimClass] ?? '?'}
            </span>
            <span className="text-gray-600 text-[10px] truncate">
              {k.reason}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function ChatLog({
  messages,
  team,
}: {
  messages: ChatMessage[];
  team: 'A' | 'B';
}) {
  const teamColor = team === 'A' ? 'text-blue-400' : 'text-red-400';
  return (
    <div className="flex flex-col gap-1">
      {messages.length === 0 && (
        <p className="text-gray-600 text-xs italic">No messages</p>
      )}
      {messages.map((m, i) => (
        <div key={i} className="text-xs">
          <span className="text-gray-500 mr-1">T{m.turn}</span>
          <span className={`font-semibold ${teamColor}`}>{m.from}:</span>{' '}
          <span className="text-gray-300">&ldquo;{m.message}&rdquo;</span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ReplayPage
// ---------------------------------------------------------------------------

export default function ReplayPage() {
  const { id } = useParams<{ id: string }>();
  const [currentTurn, setCurrentTurn] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [selectedTeam, setSelectedTeam] = useState<'A' | 'B' | 'all'>('all');
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

  // Resolve the spectator plugin for game-type-specific rendering
  const plugin = useMemo(
    () => (replay ? getSpectatorPlugin(replay.gameType) : null),
    [replay],
  );

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

  // Fog-of-war: use server-computed visibleA/visibleB if available
  const fogTiles = useMemo(() => {
    if (selectedTeam === 'all' || !turnState) return undefined;

    // Server provides visibleA/visibleB as arrays of hex keys
    const visibleSet: Set<string> | null =
      selectedTeam === 'A' && turnState.visibleA
        ? new Set(turnState.visibleA as string[])
        : selectedTeam === 'B' && turnState.visibleB
          ? new Set(turnState.visibleB as string[])
          : null;

    if (!visibleSet || !turnState.tiles) return undefined;

    const fog = new Set<string>();
    for (const tile of turnState.tiles as { q: number; r: number }[]) {
      const key = `${tile.q},${tile.r}`;
      if (!visibleSet.has(key)) fog.add(key);
    }
    return fog;
  }, [turnState, selectedTeam]);

  // Accumulate kills and chat up to current turn
  const { cumulativeKills, cumulativeChatA, cumulativeChatB } = useMemo(() => {
    const kills: KillEvent[] = [];
    const chatA: ChatMessage[] = [];
    const chatB: ChatMessage[] = [];

    for (let i = 0; i <= currentTurn && i < snapshots.length; i++) {
      const snap = snapshots[i];
      // Each snapshot may have kills from that turn
      if (snap.kills && Array.isArray(snap.kills)) {
        for (const k of snap.kills) {
          // Deduplicate by checking if we already have this kill
          // (kills in snapshot are from that progress point only)
          const exists = kills.some(
            (existing) =>
              existing.killerId === k.killerId &&
              existing.victimId === k.victimId &&
              existing.turn === (k.turn ?? i),
          );
          if (!exists) {
            kills.push({
              killerId: k.killerId ?? '',
              killerClass: k.killerClass ?? k.killerUnitClass ?? '',
              killerTeam: k.killerTeam ?? 'A',
              victimId: k.victimId ?? '',
              victimClass: k.victimClass ?? k.victimUnitClass ?? '',
              victimTeam: k.victimTeam ?? 'A',
              reason: k.reason ?? '',
              turn: k.turn ?? i,
            });
          }
        }
      }
      // Chat: snapshots have chatA/chatB with all messages up to that point
      // We just use the latest snapshot's chat arrays
      if (i === currentTurn) {
        if (snap.chatA) chatA.push(...snap.chatA);
        if (snap.chatB) chatB.push(...snap.chatB);
      }
    }

    return { cumulativeKills: kills, cumulativeChatA: chatA, cumulativeChatB: chatB };
  }, [snapshots, currentTurn]);

  // Chat messages based on perspective
  const chatMessages = useMemo(() => {
    if (selectedTeam === 'A') return cumulativeChatA;
    if (selectedTeam === 'B') return cumulativeChatB;
    return [...cumulativeChatA, ...cumulativeChatB].sort(
      (a, b) => a.turn - b.turn,
    );
  }, [cumulativeChatA, cumulativeChatB, selectedTeam]);

  const chatTeamLabel =
    selectedTeam === 'all' ? 'All Chat' : `Team ${selectedTeam} Chat`;

  const teamButtons: { label: string; value: 'A' | 'B' | 'all' }[] = [
    { label: 'Team A', value: 'A' },
    { label: 'Team B', value: 'B' },
    { label: 'Full Reveal', value: 'all' },
  ];

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

  if (!turnState) return null;

  const isFinished = turnState.phase === 'finished' || turnState.winner;
  const winner = turnState.winner ?? null;

  // Flag status (CtL-specific but graceful for other games)
  const flagA = turnState.flagA ?? null;
  const flagB = turnState.flagB ?? null;
  const mapRadius = turnState.mapRadius ?? 5;
  const tiles = turnState.tiles ?? [];

  // Check if this is a CtL game with hex grid
  const hasHexGrid = tiles.length > 0;

  // For game types with a SpectatorPlugin, delegate rendering
  if (plugin && !hasHexGrid) {
    // Non-hex game types: use the plugin's SpectatorView
    return (
      <div className="flex flex-col h-[calc(100vh-5rem)] -mx-6 -my-8 px-4 py-3 gap-2">
        <ScrubberBar
          currentTurn={currentTurn}
          totalTurns={totalTurns}
          isPlaying={isPlaying}
          isFinished={!!isFinished}
          winner={winner}
          gameId={id ?? ''}
          onPrev={goPrev}
          onNext={goNext}
          onTogglePlay={togglePlay}
          onSeek={(t) => {
            setIsPlaying(false);
            setCurrentTurn(t);
          }}
        />
        <div className="flex-1 min-h-0">
          <plugin.SpectatorView
            gameState={turnState}
            chatMessages={chatMessages}
            handles={replay.handles}
            gameId={id ?? ''}
            gameType={replay.gameType}
            phase={isFinished ? 'finished' : 'in_progress'}
          />
        </div>
      </div>
    );
  }

  // Default: CtL hex grid replay (or any game with tiles)
  return (
    <div className="flex flex-col h-[calc(100vh-5rem)] -mx-6 -my-8 px-4 py-3 gap-2">
      {/* Top bar — title + scrubber */}
      <ScrubberBar
        currentTurn={currentTurn}
        totalTurns={totalTurns}
        isPlaying={isPlaying}
        isFinished={!!isFinished}
        winner={winner}
        gameId={id ?? ''}
        onPrev={goPrev}
        onNext={goNext}
        onTogglePlay={togglePlay}
        onSeek={(t) => {
          setIsPlaying(false);
          setCurrentTurn(t);
        }}
      />

      {/* Main content area */}
      <div className="flex gap-2 flex-1 min-h-0">
        {/* Hex grid */}
        <div className="flex-1 bg-gray-900/50 rounded-lg p-2 flex items-center justify-center min-w-0">
          <HexGrid
            tiles={tiles}
            fogTiles={fogTiles}
            mapRadius={mapRadius}
            selectedTeam={selectedTeam}
          />
        </div>

        {/* Right sidebar */}
        <div className="w-56 shrink-0 flex flex-col gap-2">
          {/* Kill feed */}
          <div className="bg-gray-900 rounded-lg p-3 flex flex-col gap-2 max-h-[40%] overflow-hidden">
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
              Kill Feed
            </h3>
            <div className="overflow-y-auto flex-1 scrollbar-thin">
              <KillFeed kills={cumulativeKills} />
            </div>
          </div>

          {/* Chat log */}
          <div className="bg-gray-900 rounded-lg p-3 flex flex-col gap-2 flex-1 overflow-hidden">
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
              {chatTeamLabel}
            </h3>
            <div className="overflow-y-auto flex-1 scrollbar-thin">
              <ChatLog
                messages={chatMessages}
                team={selectedTeam === 'all' ? 'A' : selectedTeam}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Bottom bar — perspective toggle + flag status */}
      <div className="flex items-center justify-between bg-gray-900 rounded-lg px-4 py-2 shrink-0">
        <div className="flex items-center gap-4">
          {/* Perspective toggle */}
          <div className="flex items-center gap-1">
            {teamButtons.map((btn) => (
              <button
                key={btn.value}
                onClick={() => setSelectedTeam(btn.value)}
                className={`px-3 py-1 text-xs rounded font-medium transition-colors ${
                  selectedTeam === btn.value
                    ? btn.value === 'A'
                      ? 'bg-blue-900/60 text-blue-300'
                      : btn.value === 'B'
                        ? 'bg-red-900/60 text-red-300'
                        : 'bg-emerald-900/60 text-emerald-300'
                    : 'bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200'
                }`}
              >
                {btn.label}
              </button>
            ))}
          </div>

          {/* Flag A status */}
          {flagA && (
            <div className="flex items-center gap-2 text-sm">
              <span className="text-lg">{'🦞'}</span>
              <span className="text-blue-400 font-semibold">Flag A:</span>
              <span className="text-gray-300">
                {flagA.status === 'carried'
                  ? `Carried by ${replay.handles[flagA.carrier] ?? flagA.carrier}`
                  : 'At Base'}
              </span>
            </div>
          )}
        </div>

        {/* Flag B status */}
        {flagB && (
          <div className="flex items-center gap-2 text-sm">
            <span className="text-red-400 font-semibold">Flag B:</span>
            <span className="text-gray-300">
              {flagB.status === 'carried'
                ? `Carried by ${replay.handles[flagB.carrier] ?? flagB.carrier}`
                : 'At Base'}
            </span>
            <span className="text-lg">{'🦞'}</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Scrubber bar (reusable across game types)
// ---------------------------------------------------------------------------

function ScrubberBar({
  currentTurn,
  totalTurns,
  isPlaying,
  isFinished,
  winner,
  gameId,
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
            Replay{' '}
            <span className="font-mono text-emerald-400">{gameId}</span>
          </span>
          <span className="text-sm font-semibold text-gray-200">
            Turn {currentTurn}/{totalTurns - 1}
          </span>
        </div>

        {isFinished && winner && (
          <span className="text-sm font-bold px-3 py-1 rounded bg-emerald-800 text-emerald-200 animate-pulse">
            Team {winner} Wins!
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
