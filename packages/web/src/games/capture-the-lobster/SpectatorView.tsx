import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import HexGrid from '../../../../games/capture-the-lobster/web/HexGrid';
import type {
  ChatMessage,
  KillEvent,
  SpectatorGameState,
} from '../../../../games/capture-the-lobster/web/types';
import { ScrubberSlider } from '../../components/ScrubberSlider';
import { SpectatorPendingPlaceholder } from '../../components/SpectatorPendingPlaceholder';
import { API_BASE } from '../../config.js';
import type { SpectatorViewProps } from '../types';
import { useHexAnimations } from './useHexAnimations';

// Raw spectator-visible snapshot shape. Canonical source is
// buildCtlSpectatorView in packages/games/capture-the-lobster/src/plugin.ts.
// Kept as an open record to accept both /replay entries and WS envelopes
// (which spread the snapshot plus type/gameType/handles/progressCounter).
type RawSnapshot = Record<string, unknown>;

type RewindState =
  | { mode: 'live' }
  | { mode: 'loading' }
  | { mode: 'active'; index: number; snapshots: RawSnapshot[] };

// ---------------------------------------------------------------------------
// Map server state -> frontend types (CtL-specific)
// ---------------------------------------------------------------------------

/**
 * Loose shape the mapper walks — every field is optional because both the
 * replay payload and the live WS envelope may be missing arbitrary parts.
 * All narrowing happens here; downstream consumers see the strict
 * `SpectatorGameState`.
 */
interface RawCtlStateLike {
  tiles?: Array<{
    q: number;
    r: number;
    type: 'ground' | 'wall' | 'base_a' | 'base_b';
    unit?: {
      id: string;
      team: 'A' | 'B';
      unitClass: 'rogue' | 'knight' | 'mage';
      carryingFlag?: boolean;
      alive?: boolean;
    };
    flag?: { team: 'A' | 'B' };
  }>;
  units?: Array<{
    id: string;
    team?: 'A' | 'B';
    unitClass?: 'rogue' | 'knight' | 'mage';
  }>;
  kills?: Array<{
    killerId: string;
    victimId: string;
    killerClass?: string;
    killerUnitClass?: string;
    killerTeam?: 'A' | 'B';
    victimClass?: string;
    victimUnitClass?: string;
    victimTeam?: 'A' | 'B';
    reason: string;
    turn?: number;
  }>;
  turn?: number;
  maxTurns?: number;
  phase?: 'pre_game' | 'in_progress' | 'finished';
  chatA?: SpectatorGameState['chatA'];
  chatB?: SpectatorGameState['chatB'];
  flagA?: { status?: string; carrier?: string };
  flagB?: { status?: string; carrier?: string };
  winner?: 'A' | 'B' | null;
  mapRadius?: number;
  visibleA?: string[];
  visibleB?: string[];
  visibleByUnit?: Record<string, string[]>;
  handles?: Record<string, string>;
  deathPositions?: Record<string, { q: number; r: number }>;
}

function mapServerState(raw: unknown): SpectatorGameState | null {
  if (!raw || typeof raw !== 'object') return null;
  const top = raw as { data?: unknown };
  const dataCandidate = top.data ?? raw;
  if (!dataCandidate || typeof dataCandidate !== 'object') return null;
  const data = dataCandidate as RawCtlStateLike;

  if (!data.tiles || !Array.isArray(data.tiles)) return null;

  const tiles: SpectatorGameState['tiles'] = data.tiles.map((t) => {
    const base: SpectatorGameState['tiles'][number] = {
      q: t.q,
      r: t.r,
      type: t.type,
    };
    if (t.unit) {
      base.unit = {
        id: t.unit.id,
        team: t.unit.team,
        unitClass: t.unit.unitClass,
        carryingFlag: t.unit.carryingFlag || false,
        alive: t.unit.alive !== false,
      };
    }
    if (t.flag) base.flag = t.flag;
    return base;
  });

  const unitMap = new Map<string, { team?: 'A' | 'B'; unitClass?: string }>();
  for (const u of data.units ?? []) {
    unitMap.set(u.id, u);
  }

  const kills: KillEvent[] = (data.kills ?? []).map((k) => {
    const killer = unitMap.get(k.killerId);
    const victim = unitMap.get(k.victimId);
    return {
      killerId: k.killerId,
      killerClass: killer?.unitClass ?? k.killerClass ?? k.killerUnitClass ?? 'unknown',
      killerTeam: killer?.team ?? k.killerTeam ?? 'A',
      victimId: k.victimId,
      victimClass: victim?.unitClass ?? k.victimClass ?? k.victimUnitClass ?? 'unknown',
      victimTeam: victim?.team ?? k.victimTeam ?? 'B',
      reason: k.reason,
      turn: k.turn ?? data.turn ?? 0,
    };
  });

  const flagA = data.flagA ?? { status: 'at_base' };
  const flagB = data.flagB ?? { status: 'at_base' };

  const flagAStatus =
    flagA.status === 'carried' && flagA.carrier ? `Carried by ${flagA.carrier}` : 'At Base';
  const flagBStatus =
    flagB.status === 'carried' && flagB.carrier ? `Carried by ${flagB.carrier}` : 'At Base';

  const out: SpectatorGameState = {
    turn: data.turn ?? 0,
    maxTurns: data.maxTurns ?? 30,
    phase: data.phase ?? 'in_progress',
    timeRemaining: 30,
    tiles,
    kills,
    chatA: data.chatA ?? [],
    chatB: data.chatB ?? [],
    flagA: { status: flagAStatus },
    flagB: { status: flagBStatus },
    winner: data.winner ?? null,
    mapRadius: data.mapRadius ?? 8,
    visibleA: new Set(data.visibleA ?? []),
    visibleB: new Set(data.visibleB ?? []),
    visibleByUnit: Object.fromEntries(
      Object.entries(data.visibleByUnit ?? {}).map(([id, hexes]) => [id, new Set(hexes)]),
    ),
    handles: data.handles ?? {},
  };
  if (data.deathPositions) out.deathPositions = data.deathPositions;
  return out;
}

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
      {kills.length === 0 && <p className="text-gray-600 text-xs italic">No kills yet</p>}
      {[...kills].reverse().map((k, i) => {
        const killerColor = k.killerTeam === 'A' ? 'text-blue-400' : 'text-red-400';
        const victimColor = k.victimTeam === 'A' ? 'text-blue-400' : 'text-red-400';
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: list is stable; refactor in cleanup followup — TODO(2.3-followup)
          <div key={i} className="text-xs flex items-center gap-1 text-gray-300">
            <span className="text-gray-500 w-6 text-right shrink-0">T{k.turn}</span>
            <span className={`font-bold ${killerColor}`}>{CLASS_ICONS[k.killerClass]}</span>
            <span className="text-gray-500">&rarr;</span>
            <span className={`font-bold ${victimColor} line-through opacity-60`}>
              {CLASS_ICONS[k.victimClass]}
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
  handles,
  unitLabels,
}: {
  messages: ChatMessage[];
  team: 'A' | 'B';
  handles?: Record<string, string>;
  unitLabels?: Record<string, string>;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const shouldAutoScroll = useRef(true);

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
    shouldAutoScroll.current = atBottom;
  };

  useEffect(() => {
    if (shouldAutoScroll.current && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, []);

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      className="flex flex-col gap-1 overflow-y-auto h-full"
    >
      {messages.length === 0 && <p className="text-gray-600 text-xs italic">No messages</p>}
      {messages.map((m, i) => {
        const msgTeam = m.team ?? team;
        const teamColor = msgTeam === 'A' ? 'text-blue-400' : 'text-red-400';
        const name = handles?.[m.from] ?? m.from;
        const label = unitLabels?.[m.from];
        const displayName = label ? `${name} (${label})` : name;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: list is stable; refactor in cleanup followup — TODO(2.3-followup)
          <div key={i} className="text-xs">
            <span className={`font-semibold ${teamColor}`}>{displayName}:</span>{' '}
            <span className="text-gray-300">&ldquo;{m.message}&rdquo;</span>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Lobby chat message type
// ---------------------------------------------------------------------------

interface LobbyChatMessage {
  from: string;
  message: string;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// CtlSpectatorView — the main spectator component for Capture the Lobster
// ---------------------------------------------------------------------------

export function CtlSpectatorView(props: SpectatorViewProps) {
  const {
    gameState: rawGameState,
    gameId,
    replaySnapshots,
    prevGameState: rawPrevState,
    animate,
    liveSnapshot,
    liveIsLive,
    liveError,
  } = props;
  const isReplay = replaySnapshots != null;

  // Internal state for CtL-specific rendering
  const [selectedTeam, setSelectedTeam] = useState<'A' | 'B' | 'all'>('all');
  const [selectedUnit, setSelectedUnit] = useState<string | null>(null);
  const [liveState, setLiveState] = useState<SpectatorGameState | null>(null);
  const [allKills, setAllKills] = useState<KillEvent[]>([]);
  // Server reported { type: 'spectator_pending' } — delay hasn't elapsed.
  const [pendingWindow, setPendingWindow] = useState(false);
  const [lobbyChat, setLobbyChat] = useState<LobbyChatMessage[]>([]);
  const [preGameChatA, setPreGameChatA] = useState<LobbyChatMessage[]>([]);
  const [preGameChatB, setPreGameChatB] = useState<LobbyChatMessage[]>([]);
  const [showLobbyChat, setShowLobbyChat] = useState(false);

  // Live scrubber state — see docs/plans/live-scrubber.md
  const [rewind, setRewind] = useState<RewindState>({ mode: 'live' });
  const snapshotCacheRef = useRef<Map<number, RawSnapshot>>(new Map());
  const [latestProgress, setLatestProgress] = useState<number | null>(null);
  const rewindRef = useRef<RewindState>(rewind);
  useEffect(() => {
    rewindRef.current = rewind;
  }, [rewind]);

  // ---------------------------------------------------------------------------
  // Replay mode: derive state from props (no fetch, no websocket)
  // ---------------------------------------------------------------------------

  const replayState = useMemo(() => {
    if (!isReplay || !rawGameState) return null;
    return mapServerState(rawGameState);
  }, [isReplay, rawGameState]);

  const prevReplayState = useMemo(() => {
    if (!isReplay || !rawPrevState) return null;
    return mapServerState(rawPrevState);
  }, [isReplay, rawPrevState]);

  // ---------------------------------------------------------------------------
  // Live mode (Phase 7.2): the WS lifecycle now lives in GamePage's single
  // `useSpectatorStream`. We project the unified spectator payload (passed
  // in via props) onto CtL-specific (liveState, snapshot cache, rewind)
  // state. Rewind machinery stays co-located here because it depends on
  // `mapServerState` + the cache.
  // ---------------------------------------------------------------------------

  /**
   * The live-mode spectator payload shape we actually touch. `SpectatorView`
   * accepts `liveSnapshot` as `unknown` in the shared props (to keep the
   * dependency graph one-way); narrow to the useful subset at this boundary.
   */
  interface LiveSnapshotLike {
    type: 'state_update' | 'spectator_pending';
    meta: { progressCounter: number | null; handles: Record<string, string> };
    state: Record<string, unknown> | null;
  }
  const snapshot = isReplay ? undefined : (liveSnapshot as LiveSnapshotLike | undefined);
  const connected = !isReplay && (liveIsLive ?? false);
  const error = liveError ?? null;

  useEffect(() => {
    if (isReplay || !snapshot) return;
    if (snapshot.type === 'spectator_pending') {
      setPendingWindow(true);
      // Preserve liveState during an open rewind session — otherwise the
      // !gameState gate below would tear down the rewind UI even though
      // the cached snapshots are still valid.
      if (rewindRef.current.mode === 'live') setLiveState(null);
      return;
    }
    setPendingWindow(false);
    // The unified payload's `state` IS the spectator snapshot. Rebuild a
    // legacy-shaped raw envelope (with progressCounter at top level) so
    // `mapServerState` and the snapshot cache keep working without
    // change. This is a BOUNDARY adapter — once Phase 6 unifies the
    // SpectatorView API the cache can store payloads directly.
    const idx = snapshot.meta.progressCounter ?? 0;
    const stateObj: Record<string, unknown> = snapshot.state ?? {};
    const raw: RawSnapshot = {
      ...stateObj,
      progressCounter: idx,
      handles: snapshot.meta.handles,
    };
    const mapped = mapServerState(raw);
    if (!mapped) return;
    setLiveState(mapped);
    snapshotCacheRef.current.set(idx, raw);
    setLatestProgress((prev) => (prev === null || idx > prev ? idx : prev));
    if (mapped.kills.length > 0) {
      setAllKills((prev) => {
        const existing = new Set(prev.map((k) => `${k.turn}:${k.victimId}`));
        const newKills = mapped.kills.filter((k) => !existing.has(`${k.turn}:${k.victimId}`));
        return newKills.length > 0 ? [...prev, ...newKills] : prev;
      });
    }
    // lobby/pre-game chat fields ride on the same state shape — pull
    // them through if the spectator state still exposes them.
    if (Array.isArray(stateObj.lobbyChat)) setLobbyChat(stateObj.lobbyChat);
    if (Array.isArray(stateObj.preGameChatA)) setPreGameChatA(stateObj.preGameChatA);
    if (Array.isArray(stateObj.preGameChatB)) setPreGameChatB(stateObj.preGameChatB);
  }, [isReplay, snapshot]);

  // ---------------------------------------------------------------------------
  // Live scrubber — enterRewind, backToLive, cache alignment, auto-exit
  // See docs/plans/live-scrubber.md
  // ---------------------------------------------------------------------------

  const enterRewind = useCallback(async () => {
    if (latestProgress === null) return;
    setRewind({ mode: 'loading' });

    let haveAll = true;
    for (let i = 0; i <= latestProgress; i++) {
      if (!snapshotCacheRef.current.has(i)) {
        haveAll = false;
        break;
      }
    }

    if (!haveAll) {
      try {
        const res = await fetch(`${API_BASE}/games/${gameId}/replay`, { cache: 'no-store' });
        const data = await res.json();
        if (rewindRef.current.mode !== 'loading') return; // user bailed or game ended
        if (data?.type === 'replay' && Array.isArray(data.snapshots)) {
          data.snapshots.forEach((s: RawSnapshot, i: number) => {
            if (!snapshotCacheRef.current.has(i)) {
              snapshotCacheRef.current.set(i, s);
            }
          });
        } else {
          setRewind({ mode: 'live' });
          return;
        }
      } catch {
        if (rewindRef.current.mode === 'loading') setRewind({ mode: 'live' });
        return;
      }
    }

    // latestProgress may have advanced during the await — read fresh.
    const frozenLatest = latestProgress;
    const snapshots: RawSnapshot[] = [];
    for (let i = 0; i <= frozenLatest; i++) {
      const snap = snapshotCacheRef.current.get(i);
      if (!snap) {
        console.warn('[live-scrubber] cache gap at index', i);
        setRewind({ mode: 'live' });
        return;
      }
      snapshots.push(snap);
    }
    setRewind({ mode: 'active', index: frozenLatest, snapshots });
  }, [gameId, latestProgress]);

  const backToLive = useCallback(() => {
    setRewind({ mode: 'live' });
  }, []);

  // §6.5 Keep rewind.snapshots aligned with cache growth.
  useEffect(() => {
    if (rewind.mode !== 'active') return;
    if (latestProgress === null) return;
    if (rewind.snapshots.length - 1 >= latestProgress) return;

    setRewind((r) => {
      if (r.mode !== 'active') return r;
      const snapshots: RawSnapshot[] = [];
      for (let i = 0; i <= latestProgress; i++) {
        const snap = snapshotCacheRef.current.get(i);
        if (!snap) {
          console.warn('[live-scrubber] cache gap at index', i);
          return r;
        }
        snapshots.push(snap);
      }
      const index = Math.min(r.index, snapshots.length - 1);
      return { mode: 'active', index, snapshots };
    });
    // @ts-expect-error TS2339: Property 'snapshots' does not exist on type 'RewindState'. — TODO(2.3-followup)
  }, [latestProgress, rewind.mode, rewind.snapshots.length]);

  // §6.9 Auto-exit rewind when the game ends — /replay is the right surface
  // for a finished game.
  useEffect(() => {
    if (liveState?.phase === 'finished' && rewindRef.current.mode !== 'live') {
      setRewind({ mode: 'live' });
    }
  }, [liveState?.phase]);

  // ---------------------------------------------------------------------------
  // Unified state: replay, rewind, or live
  // ---------------------------------------------------------------------------

  const displayRaw = rewind.mode === 'active' ? rewind.snapshots[rewind.index] : null;
  const rewindDisplayState = useMemo(
    () => (displayRaw ? mapServerState(displayRaw) : null),
    [displayRaw],
  );

  const gameState = isReplay ? replayState : (rewindDisplayState ?? liveState);
  const prevGameState = isReplay ? prevReplayState : null;
  const displayKills = isReplay
    ? (replayState?.kills ?? [])
    : rewind.mode === 'active'
      ? (rewindDisplayState?.kills ?? [])
      : allKills;
  const effectiveAnimate = rewind.mode === 'active' ? false : (animate ?? false);

  // Animation — disabled in rewind (instant snap per scrub)
  const animState = useHexAnimations(
    prevGameState?.tiles ?? null,
    gameState?.tiles ?? [],
    effectiveAnimate,
    displayKills,
    gameState?.deathPositions,
  );

  const teamButtons: { label: string; value: 'A' | 'B' | 'all' }[] = [
    { label: 'All', value: 'all' },
    { label: 'Team A', value: 'A' },
    { label: 'Team B', value: 'B' },
  ];

  // Fog of war for selected team
  const fogTiles = useMemo(() => {
    if (selectedTeam === 'all' || !gameState) return undefined;

    const visibleSet = selectedTeam === 'A' ? gameState.visibleA : gameState.visibleB;
    if (!visibleSet || visibleSet.size === 0) return undefined;

    const fog = new Set<string>();
    for (const tile of gameState.tiles) {
      const key = `${tile.q},${tile.r}`;
      if (!visibleSet.has(key)) fog.add(key);
    }
    return fog;
  }, [gameState, selectedTeam]);

  if (!gameState) {
    if (pendingWindow && !isReplay) {
      return <SpectatorPendingPlaceholder title="Game in progress" />;
    }
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <div className="text-4xl mb-4">🦞</div>
          <p className="text-gray-400">
            {error
              ? error
              : connected
                ? 'Waiting for game data...'
                : isReplay
                  ? 'Loading replay...'
                  : `Connecting to game ${gameId}...`}
          </p>
        </div>
      </div>
    );
  }

  // Build unit labels (e.g. "R1", "K2") from tile data
  const unitLabels: Record<string, string> = {};
  const teamACounts: string[] = [];
  const teamBCounts: string[] = [];
  for (const tile of gameState.tiles) {
    if (tile.unit?.id) {
      // @ts-expect-error TS2532: Object is possibly 'undefined'. — TODO(2.3-followup)
      const classLetter = tile.unit.unitClass[0].toUpperCase();
      if (tile.unit.team === 'A') {
        teamACounts.push(tile.unit.id);
        unitLabels[tile.unit.id] = `${classLetter}${teamACounts.length}`;
      } else {
        teamBCounts.push(tile.unit.id);
        unitLabels[tile.unit.id] = `${classLetter}${teamBCounts.length}`;
      }
    }
  }

  const chatMessages =
    selectedTeam === 'A'
      ? gameState.chatA.map((m) => ({ ...m, team: 'A' as const }))
      : selectedTeam === 'B'
        ? gameState.chatB.map((m) => ({ ...m, team: 'B' as const }))
        : [
            ...gameState.chatA.map((m) => ({ ...m, team: 'A' as const })),
            ...gameState.chatB.map((m) => ({ ...m, team: 'B' as const })),
          ].sort((a, b) => a.turn - b.turn);

  const chatTeamLabel = selectedTeam === 'all' ? 'All Chat' : `Team ${selectedTeam} Chat`;

  const handlePerspectiveChange = (value: 'A' | 'B' | 'all') => {
    setSelectedTeam(value);
    setSelectedUnit(null);
  };

  return (
    <div className="flex flex-col h-full -mx-4 sm:-mx-6 px-2 sm:px-4 pt-0 pb-3 gap-2">
      {/* Top bar */}
      <div className="flex flex-wrap items-center justify-between bg-gray-900 rounded-lg px-3 py-2 shrink-0 gap-2">
        <div className="flex items-center gap-2 sm:gap-4">
          <span className="text-sm font-semibold text-gray-200">
            Turn {gameState.turn}/{gameState.maxTurns}
          </span>
          {!isReplay && !connected && <span className="text-xs text-yellow-500">disconnected</span>}
          {/* FINISHED reads from liveState (not gameState) so scrubbing
              through past turns during rewind doesn't flash a misleading
              FINISHED badge when the game is still active. In replay
              mode fall back to replayState since there is no liveState. */}
          {(isReplay ? gameState.phase === 'finished' : liveState?.phase === 'finished') && (
            <span className="text-xs font-bold px-2 py-0.5 rounded bg-emerald-800 text-emerald-200">
              FINISHED
              {(isReplay ? gameState.winner : liveState?.winner) &&
                ` — Team ${isReplay ? gameState.winner : liveState?.winner} wins`}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {selectedUnit && (
            <button
              type="button"
              onClick={() => setSelectedUnit(null)}
              className="px-2 py-1 text-xs rounded font-medium bg-yellow-900/60 text-yellow-300 hover:bg-yellow-800/60 mr-1 cursor-pointer"
            >
              {gameState.handles?.[selectedUnit] ?? unitLabels[selectedUnit] ?? selectedUnit} PoV x
            </button>
          )}
          {teamButtons.map((btn) => (
            <button
              type="button"
              key={btn.value}
              onClick={() => handlePerspectiveChange(btn.value)}
              className={`px-2 sm:px-3 py-1 text-xs rounded font-medium transition-colors cursor-pointer ${
                selectedTeam === btn.value
                  ? btn.value === 'A'
                    ? 'bg-blue-900/60 text-blue-300'
                    : btn.value === 'B'
                      ? 'bg-red-900/60 text-red-300'
                      : 'bg-gray-700 text-gray-100'
                  : 'bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200'
              }`}
            >
              {btn.label}
            </button>
          ))}
          {/* Rewind toggle — shown only for live mode when there's
              something worth rewinding through and the game is ongoing. */}
          {!isReplay &&
            rewind.mode !== 'active' &&
            latestProgress !== null &&
            latestProgress >= 1 &&
            liveState?.phase !== 'finished' && (
              <button
                type="button"
                onClick={enterRewind}
                disabled={rewind.mode === 'loading'}
                className="ml-1 px-2 sm:px-3 py-1 text-xs rounded font-medium transition-colors cursor-pointer bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200 disabled:opacity-50 disabled:cursor-wait"
                title="Rewind to past turns (live view keeps updating in background)"
              >
                {rewind.mode === 'loading' ? '…' : '↻ Rewind'}
              </button>
            )}
        </div>
      </div>

      {/* Live scrubber row — visible only while rewind is active. */}
      {!isReplay && rewind.mode === 'active' && (
        <div className="flex items-center gap-3 bg-gray-900 rounded-lg px-3 py-2 shrink-0">
          <span className="text-xs font-semibold text-amber-400 shrink-0">
            Rewind · Turn {gameState?.turn ?? 0}
          </span>
          <ScrubberSlider
            currentTurn={rewind.index}
            totalTurns={rewind.snapshots.length}
            onSeek={(i) => setRewind((r) => (r.mode === 'active' ? { ...r, index: i } : r))}
            onPrev={() =>
              setRewind((r) =>
                r.mode === 'active' ? { ...r, index: Math.max(0, r.index - 1) } : r,
              )
            }
            onNext={() =>
              setRewind((r) =>
                r.mode === 'active'
                  ? { ...r, index: Math.min(r.snapshots.length - 1, r.index + 1) }
                  : r,
              )
            }
          />
          <button
            type="button"
            onClick={backToLive}
            className="px-3 py-1 text-xs rounded font-semibold bg-emerald-800 text-emerald-200 hover:bg-emerald-700 transition-colors cursor-pointer shrink-0"
            title="Return to live view"
          >
            ↻ Back to live
          </button>
        </div>
      )}

      {/* Main content area */}
      <div className="flex flex-col md:flex-row gap-2 flex-1 min-h-0 md:overflow-hidden">
        {/* Hex grid */}
        <div className="flex-1 bg-gray-900/50 rounded-lg p-1 flex items-center justify-center min-w-0 aspect-square md:aspect-auto md:min-h-0 overflow-hidden relative">
          {/* Full-screen overlay reads from liveState for the same reason
              as the FINISHED badge above — rewind scrubbing must never
              surface a spurious win screen. */}
          {(() => {
            const finishSrc = isReplay ? gameState : liveState;
            if (!finishSrc || finishSrc.phase !== 'finished') return null;
            return (
              <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/60 backdrop-blur-sm rounded-lg">
                <div className="text-center px-8 py-6">
                  {finishSrc.winner ? (
                    <>
                      <div
                        className="text-5xl md:text-7xl font-black mb-3"
                        style={{ color: finishSrc.winner === 'A' ? '#60a5fa' : '#f87171' }}
                      >
                        {finishSrc.winner === 'A' ? '' : ''} TEAM {finishSrc.winner} WINS!
                      </div>
                      <div className="text-xl md:text-2xl text-gray-300 font-medium">
                        captured the lobster
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="text-5xl md:text-7xl font-black text-gray-400 mb-3">DRAW</div>
                      <div className="text-xl md:text-2xl text-gray-500 font-medium">
                        Turn limit reached — no capture
                      </div>
                    </>
                  )}
                </div>
              </div>
            );
          })()}
          {/* @ts-expect-error TS2375: Type '{ tiles: VisibleTile[]; fogTiles: Set<string> | undefined; mapRadius: numb — TODO(2.3-followup) */}
          <HexGrid
            tiles={gameState.tiles}
            fogTiles={fogTiles}
            mapRadius={gameState.mapRadius}
            selectedTeam={selectedTeam}
            visibleA={gameState.visibleA}
            visibleB={gameState.visibleB}
            visibleOverride={
              selectedUnit && gameState.visibleByUnit?.[selectedUnit]
                ? gameState.visibleByUnit[selectedUnit]
                : undefined
            }
            floatingUnits={animState.floatingUnits}
            hiddenUnitIds={animState.hiddenUnitIds.size > 0 ? animState.hiddenUnitIds : undefined}
            killEffects={animState.killEffects}
            visionOpacity={animState.visionOpacity}
            dyingUnitIds={animState.dyingUnitIds.size > 0 ? animState.dyingUnitIds : undefined}
            onUnitClick={(unitId, team) => {
              if (selectedUnit === unitId) {
                setSelectedUnit(null);
                setSelectedTeam(team);
              } else {
                setSelectedUnit(unitId);
                setSelectedTeam(team);
              }
            }}
          />
        </div>

        {/* Sidebar */}
        <div className="flex flex-col gap-2 md:w-52 shrink-0 min-h-0 overflow-hidden">
          {/* Kill feed */}
          <div className="bg-gray-900 rounded-lg p-3 flex flex-col gap-2 max-h-32 md:max-h-[40%] overflow-hidden">
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Kills</h3>
            <div className="overflow-y-auto flex-1">
              <KillFeed kills={displayKills} />
            </div>
          </div>

          {/* Chat log */}
          <div className="bg-gray-900 rounded-lg p-3 flex flex-col gap-2 max-h-48 md:max-h-none md:flex-1 overflow-hidden">
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
              {chatTeamLabel}
            </h3>
            <div className="overflow-y-auto flex-1">
              {/* @ts-expect-error TS2375: Type '{ messages: ({ team: "A"; from: string; message: string; turn: number; } | — TODO(2.3-followup) */}
              <ChatLog
                messages={chatMessages}
                team={selectedTeam === 'all' ? 'A' : selectedTeam}
                handles={gameState.handles}
                unitLabels={unitLabels}
              />
            </div>
          </div>

          {/* Pre-game / Lobby chat (collapsible) — live mode only */}
          {!isReplay &&
            (() => {
              const preGameChat =
                selectedTeam === 'A' ? preGameChatA : selectedTeam === 'B' ? preGameChatB : [];
              const chatToShow = preGameChat.length > 0 ? preGameChat : lobbyChat;
              const chatLabel =
                preGameChat.length > 0
                  ? `Pre-Game (${preGameChat.length})`
                  : `Lobby (${lobbyChat.length})`;
              const chatColor =
                preGameChat.length > 0
                  ? selectedTeam === 'A'
                    ? 'text-blue-400'
                    : 'text-red-400'
                  : 'text-yellow-400';
              if (chatToShow.length === 0) return null;
              return (
                <div className="bg-gray-900 rounded-lg p-3 flex flex-col gap-2 max-h-40 md:max-h-[30%] overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setShowLobbyChat(!showLobbyChat)}
                    className="text-xs font-semibold text-gray-400 uppercase tracking-wider text-left flex items-center gap-1 cursor-pointer hover:text-gray-300"
                  >
                    <span className={`transition-transform ${showLobbyChat ? 'rotate-90' : ''}`}>
                      &#9654;
                    </span>
                    {chatLabel}
                  </button>
                  {showLobbyChat && (
                    <div className="overflow-y-auto flex-1">
                      <div className="flex flex-col gap-1">
                        {chatToShow.map((m, i) => {
                          const name = gameState.handles?.[m.from] ?? m.from;
                          return (
                            // biome-ignore lint/suspicious/noArrayIndexKey: list is stable; refactor in cleanup followup — TODO(2.3-followup)
                            <div key={i} className="text-xs">
                              <span className={`font-semibold ${chatColor}`}>{name}:</span>{' '}
                              <span className="text-gray-300">{m.message}</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              );
            })()}
        </div>
      </div>

      {/* Bottom bar — flag status */}
      <div className="flex items-center justify-between bg-gray-900 rounded-lg px-3 py-2 shrink-0 text-xs sm:text-sm">
        <div className="flex items-center gap-1 sm:gap-2">
          <span className="text-blue-400 font-semibold">A:</span>
          <span className="text-gray-300">{gameState.flagA.status}</span>
        </div>
        <div className="flex items-center gap-1 sm:gap-2">
          <span className="text-red-400 font-semibold">B:</span>
          <span className="text-gray-300">{gameState.flagB.status}</span>
        </div>
      </div>
    </div>
  );
}
