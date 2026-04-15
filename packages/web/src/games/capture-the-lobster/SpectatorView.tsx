import { useState, useEffect, useRef, useMemo } from 'react';
import HexGrid from '../../components/HexGrid';
import type { SpectatorViewProps } from '../types';
import { API_BASE, getWsUrl } from '../../config.js';
import type {
  SpectatorGameState,
  KillEvent,
  ChatMessage,
} from '../../types';
import { useHexAnimations } from './useHexAnimations';

// ---------------------------------------------------------------------------
// Map server state -> frontend types (CtL-specific)
// ---------------------------------------------------------------------------

function mapServerState(raw: any): SpectatorGameState | null {
  if (!raw) return null;
  const data = raw.data ?? raw;

  if (!data.tiles || !Array.isArray(data.tiles)) return null;

  const tiles = data.tiles.map((t: any) => ({
    q: t.q,
    r: t.r,
    type: t.type,
    unit: t.unit
      ? {
          id: t.unit.id,
          team: t.unit.team,
          unitClass: t.unit.unitClass,
          carryingFlag: t.unit.carryingFlag || false,
          alive: t.unit.alive !== false,
        }
      : undefined,
    flag: t.flag,
  }));

  const unitMap = new Map<string, any>();
  for (const u of data.units ?? []) {
    unitMap.set(u.id, u);
  }

  const kills: KillEvent[] = (data.kills ?? []).map((k: any) => {
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
      turn: k.turn ?? data.turn,
    };
  });

  const flagA = data.flagA ?? { status: 'at_base' };
  const flagB = data.flagB ?? { status: 'at_base' };

  const flagAStatus =
    flagA.status === 'carried' && flagA.carrier
      ? `Carried by ${flagA.carrier}`
      : 'At Base';
  const flagBStatus =
    flagB.status === 'carried' && flagB.carrier
      ? `Carried by ${flagB.carrier}`
      : 'At Base';

  return {
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
      Object.entries(data.visibleByUnit ?? {}).map(([id, hexes]: [string, any]) => [id, new Set(hexes as string[])])
    ),
    handles: data.handles ?? {},
    deathPositions: data.deathPositions ?? undefined,
  };
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
      {kills.length === 0 && (
        <p className="text-gray-600 text-xs italic">No kills yet</p>
      )}
      {[...kills].reverse().map((k, i) => {
        const killerColor = k.killerTeam === 'A' ? 'text-blue-400' : 'text-red-400';
        const victimColor = k.victimTeam === 'A' ? 'text-blue-400' : 'text-red-400';
        return (
          <div key={i} className="text-xs flex items-center gap-1 text-gray-300">
            <span className="text-gray-500 w-6 text-right shrink-0">T{k.turn}</span>
            <span className={`font-bold ${killerColor}`}>
              {CLASS_ICONS[k.killerClass]}
            </span>
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
  }, [messages.length]);

  return (
    <div ref={containerRef} onScroll={handleScroll} className="flex flex-col gap-1 overflow-y-auto h-full">
      {messages.length === 0 && (
        <p className="text-gray-600 text-xs italic">No messages</p>
      )}
      {messages.map((m, i) => {
        const msgTeam = m.team ?? team;
        const teamColor = msgTeam === 'A' ? 'text-blue-400' : 'text-red-400';
        const name = handles?.[m.from] ?? m.from;
        const label = unitLabels?.[m.from];
        const displayName = label ? `${name} (${label})` : name;
        return (
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
  const { gameState: rawGameState, gameId, handles, replaySnapshots, prevGameState: rawPrevState, animate } = props;
  const isReplay = replaySnapshots != null;

  // Internal state for CtL-specific rendering
  const [selectedTeam, setSelectedTeam] = useState<'A' | 'B' | 'all'>(props.perspective ?? 'all');
  const [selectedUnit, setSelectedUnit] = useState<string | null>(null);
  const [liveState, setLiveState] = useState<SpectatorGameState | null>(null);
  const [allKills, setAllKills] = useState<KillEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lobbyChat, setLobbyChat] = useState<LobbyChatMessage[]>([]);
  const [preGameChatA, setPreGameChatA] = useState<LobbyChatMessage[]>([]);
  const [preGameChatB, setPreGameChatB] = useState<LobbyChatMessage[]>([]);
  const [showLobbyChat, setShowLobbyChat] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  // Sync perspective from props
  useEffect(() => {
    if (props.perspective) {
      setSelectedTeam(props.perspective);
    }
  }, [props.perspective]);

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
  // Live mode: fetch initial state + connect WebSocket
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (isReplay || !gameId) return;

    fetch(`${API_BASE}/games/${gameId}`)
      .then((res) => res.json())
      .then((data) => {
        const mapped = mapServerState(data);
        if (mapped) {
          setLiveState(mapped);
          if (mapped.kills.length > 0) {
            setAllKills(mapped.kills);
          }
        }
        if (data.lobbyChat && Array.isArray(data.lobbyChat)) {
          setLobbyChat(data.lobbyChat);
        }
        if (data.preGameChatA && Array.isArray(data.preGameChatA)) {
          setPreGameChatA(data.preGameChatA);
        }
        if (data.preGameChatB && Array.isArray(data.preGameChatB)) {
          setPreGameChatB(data.preGameChatB);
        }
      })
      .catch(() => {});

    const wsUrl = getWsUrl(`/ws/game/${gameId}`);
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      setError(null);
    };

    ws.onmessage = (event) => {
      try {
        const raw = JSON.parse(event.data);
        const mapped = mapServerState(raw);
        if (mapped) {
          setLiveState(mapped);
          if (mapped.kills.length > 0) {
            setAllKills((prev) => {
              const existing = new Set(prev.map(k => `${k.turn}:${k.victimId}`));
              const newKills = mapped.kills.filter(k => !existing.has(`${k.turn}:${k.victimId}`));
              return newKills.length > 0 ? [...prev, ...newKills] : prev;
            });
          }
        }
      } catch {
        console.warn('Failed to parse WS message');
      }
    };

    ws.onerror = () => setError('WebSocket error');
    ws.onclose = () => setConnected(false);

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [gameId, isReplay]);

  // ---------------------------------------------------------------------------
  // Unified state: replay or live
  // ---------------------------------------------------------------------------

  const gameState = isReplay ? replayState : liveState;
  const prevGameState = isReplay ? prevReplayState : null;
  const displayKills = isReplay ? (replayState?.kills ?? []) : allKills;

  // Animation — only active in replay mode with animate=true
  const animState = useHexAnimations(
    prevGameState?.tiles ?? null,
    gameState?.tiles ?? [],
    animate ?? false,
    displayKills,
    gameState?.deathPositions,
  );

  const teamButtons: { label: string; value: 'A' | 'B' | 'all' }[] = [
    { label: 'All', value: 'all' },
    { label: 'Team A', value: 'A' },
    { label: 'Team B', value: 'B' },
  ];

  if (!gameState) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <div className="text-4xl mb-4">🦞</div>
          <p className="text-gray-400">
            {error ? error : connected ? 'Waiting for game data...' : isReplay ? 'Loading replay...' : `Connecting to game ${gameId}...`}
          </p>
        </div>
      </div>
    );
  }

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

  // Build unit labels (e.g. "R1", "K2") from tile data
  const unitLabels: Record<string, string> = {};
  const teamACounts: string[] = [];
  const teamBCounts: string[] = [];
  for (const tile of gameState.tiles) {
    if (tile.unit && tile.unit.id) {
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

  const chatTeamLabel =
    selectedTeam === 'all' ? 'All Chat' : `Team ${selectedTeam} Chat`;

  const handlePerspectiveChange = (value: 'A' | 'B' | 'all') => {
    setSelectedTeam(value);
    setSelectedUnit(null);
    props.onPerspectiveChange?.(value);
  };

  return (
    <div className="flex flex-col h-full -mx-4 sm:-mx-6 px-2 sm:px-4 pt-0 pb-3 gap-2">
      {/* Top bar */}
      <div className="flex flex-wrap items-center justify-between bg-gray-900 rounded-lg px-3 py-2 shrink-0 gap-2">
        <div className="flex items-center gap-2 sm:gap-4">
          <span className="text-sm font-semibold text-gray-200">
            Turn {gameState.turn}/{gameState.maxTurns}
          </span>
          {!isReplay && !connected && (
            <span className="text-xs text-yellow-500">disconnected</span>
          )}
          {gameState.phase === 'finished' && (
            <span className="text-xs font-bold px-2 py-0.5 rounded bg-emerald-800 text-emerald-200">
              FINISHED
              {gameState.winner && ` — Team ${gameState.winner} wins`}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {selectedUnit && (
            <button
              onClick={() => setSelectedUnit(null)}
              className="px-2 py-1 text-xs rounded font-medium bg-yellow-900/60 text-yellow-300 hover:bg-yellow-800/60 mr-1 cursor-pointer"
            >
              {gameState.handles?.[selectedUnit] ?? unitLabels[selectedUnit] ?? selectedUnit} PoV x
            </button>
          )}
          {teamButtons.map((btn) => (
            <button
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
        </div>
      </div>

      {/* Main content area */}
      <div className="flex flex-col md:flex-row gap-2 flex-1 min-h-0 md:overflow-hidden">
        {/* Hex grid */}
        <div className="flex-1 bg-gray-900/50 rounded-lg p-1 flex items-center justify-center min-w-0 aspect-square md:aspect-auto md:min-h-0 overflow-hidden relative">
          {gameState.phase === 'finished' && (
            <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/60 backdrop-blur-sm rounded-lg">
              <div className="text-center px-8 py-6">
                {gameState.winner ? (
                  <>
                    <div className="text-5xl md:text-7xl font-black mb-3" style={{ color: gameState.winner === 'A' ? '#60a5fa' : '#f87171' }}>
                      {gameState.winner === 'A' ? '' : ''} TEAM {gameState.winner} WINS!
                    </div>
                    <div className="text-xl md:text-2xl text-gray-300 font-medium">
                      captured the lobster
                    </div>
                  </>
                ) : (
                  <>
                    <div className="text-5xl md:text-7xl font-black text-gray-400 mb-3">
                      DRAW
                    </div>
                    <div className="text-xl md:text-2xl text-gray-500 font-medium">
                      Turn limit reached — no capture
                    </div>
                  </>
                )}
              </div>
            </div>
          )}
          {gameState.turn === 0 && gameState.phase !== 'finished' && !isReplay && (
            <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/50 backdrop-blur-sm rounded-lg">
              <div className="text-center px-8 py-6">
                <div className="text-5xl md:text-6xl mb-4">🦞</div>
                <div className="text-xl md:text-2xl font-bold text-gray-200 mb-2">
                  Game in progress
                </div>
                <div className="text-sm md:text-base text-gray-400">
                  Spectator view is delayed — waiting for first turns to resolve...
                </div>
              </div>
            </div>
          )}
          <HexGrid
            tiles={gameState.tiles}
            fogTiles={fogTiles}
            mapRadius={gameState.mapRadius}
            selectedTeam={selectedTeam}
            visibleA={gameState.visibleA}
            visibleB={gameState.visibleB}
            visibleOverride={selectedUnit && gameState.visibleByUnit?.[selectedUnit] ? gameState.visibleByUnit[selectedUnit] : undefined}
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
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
              Kills
            </h3>
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
              <ChatLog
                messages={chatMessages}
                team={selectedTeam === 'all' ? 'A' : selectedTeam}
                handles={gameState.handles}
                unitLabels={unitLabels}
              />
            </div>
          </div>

          {/* Pre-game / Lobby chat (collapsible) — live mode only */}
          {!isReplay && (() => {
            const preGameChat = selectedTeam === 'A' ? preGameChatA : selectedTeam === 'B' ? preGameChatB : [];
            const chatToShow = preGameChat.length > 0 ? preGameChat : lobbyChat;
            const chatLabel = preGameChat.length > 0
              ? `Pre-Game (${preGameChat.length})`
              : `Lobby (${lobbyChat.length})`;
            const chatColor = preGameChat.length > 0
              ? (selectedTeam === 'A' ? 'text-blue-400' : 'text-red-400')
              : 'text-yellow-400';
            if (chatToShow.length === 0) return null;
            return (
              <div className="bg-gray-900 rounded-lg p-3 flex flex-col gap-2 max-h-40 md:max-h-[30%] overflow-hidden">
                <button
                  onClick={() => setShowLobbyChat(!showLobbyChat)}
                  className="text-xs font-semibold text-gray-400 uppercase tracking-wider text-left flex items-center gap-1 cursor-pointer hover:text-gray-300"
                >
                  <span className={`transition-transform ${showLobbyChat ? 'rotate-90' : ''}`}>&#9654;</span>
                  {chatLabel}
                </button>
                {showLobbyChat && (
                  <div className="overflow-y-auto flex-1">
                    <div className="flex flex-col gap-1">
                      {chatToShow.map((m, i) => {
                        const name = gameState.handles?.[m.from] ?? m.from;
                        return (
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
