import { useState, useEffect, useRef } from 'react';
import HexGrid from '../../components/HexGrid';
import type { SpectatorViewProps } from '../types';
import type {
  SpectatorGameState,
  KillEvent,
  ChatMessage,
} from '../../types';

// ---------------------------------------------------------------------------
// Map server state → frontend types (CtL-specific)
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
      killerClass: killer?.unitClass ?? 'unknown',
      killerTeam: killer?.team ?? 'A',
      victimId: k.victimId,
      victimClass: victim?.unitClass ?? 'unknown',
      victimTeam: victim?.team ?? 'B',
      reason: k.reason,
      turn: data.turn,
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
    turnTimeoutMs: data.turnTimeoutMs ?? 30000,
    turnStartedAt: data.turnStartedAt ?? Date.now(),
    handles: data.handles ?? {},
  };
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function TurnTimer({ startedAt, timeoutMs }: { startedAt: number; timeoutMs: number }) {
  const [remaining, setRemaining] = useState(timeoutMs);

  useEffect(() => {
    const tick = () => {
      const elapsed = Date.now() - startedAt;
      setRemaining(Math.max(0, timeoutMs - elapsed));
    };
    tick();
    const interval = setInterval(tick, 200);
    return () => clearInterval(interval);
  }, [startedAt, timeoutMs]);

  const seconds = Math.ceil(remaining / 1000);
  const pct = (remaining / timeoutMs) * 100;
  const color = seconds <= 5 ? 'text-red-400' : seconds <= 10 ? 'text-yellow-400' : 'text-gray-400';

  return (
    <span className={`text-xs font-mono ${color}`}>
      {seconds}s
      <span className="ml-1 inline-block w-12 h-1.5 bg-gray-800 rounded-full overflow-hidden align-middle">
        <span
          className="block h-full rounded-full transition-all"
          style={{ width: `${pct}%`, backgroundColor: seconds <= 5 ? '#f87171' : seconds <= 10 ? '#fbbf24' : '#4ade80' }}
        />
      </span>
    </span>
  );
}

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
  const { gameState: rawGameState, gameId, handles } = props;

  // Internal state for CtL-specific rendering
  const [selectedTeam, setSelectedTeam] = useState<'A' | 'B' | 'all'>(props.perspective ?? 'all');
  const [selectedUnit, setSelectedUnit] = useState<string | null>(null);
  const [ctlState, setCtlState] = useState<SpectatorGameState | null>(null);
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

  // Fetch initial state via REST, then connect WebSocket for live updates
  useEffect(() => {
    if (!gameId) return;

    // Fetch initial state
    fetch(`/api/games/${gameId}`)
      .then((res) => res.json())
      .then((data) => {
        const mapped = mapServerState(data);
        if (mapped) {
          setCtlState(mapped);
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

    // Connect WebSocket
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws/game/${gameId}`;
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
          setCtlState(mapped);
          if (mapped.kills.length > 0) {
            setAllKills((prev) => [...prev, ...mapped.kills]);
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
  }, [gameId]);

  const gameState = ctlState;

  const teamButtons: { label: string; value: 'A' | 'B' | 'all' }[] = [
    { label: 'All', value: 'all' },
    { label: 'Team A', value: 'A' },
    { label: 'Team B', value: 'B' },
  ];

  if (!gameState) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-5rem)]">
        <div className="text-center">
          <div className="text-4xl mb-4">🦞</div>
          <p className="text-gray-400">
            {error ? error : connected ? 'Waiting for game data...' : `Connecting to game ${gameId}...`}
          </p>
        </div>
      </div>
    );
  }

  // Build unit labels (e.g. "R1", "K2") from tile data so chat can reference map
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
    <div className="flex flex-col md:h-[calc(100vh-5rem)] -mx-4 sm:-mx-6 -mb-4 sm:-mb-8 px-2 sm:px-4 pt-0 pb-3 gap-2">
      {/* Top bar */}
      <div className="flex flex-wrap items-center justify-between bg-gray-900 rounded-lg px-3 py-2 shrink-0 gap-2">
        <div className="flex items-center gap-2 sm:gap-4">
          <span className="text-sm font-semibold text-gray-200">
            Turn {gameState.turn}/{gameState.maxTurns}
          </span>
          {gameState.phase === 'in_progress' && gameState.turnStartedAt && (
            <TurnTimer startedAt={gameState.turnStartedAt} timeoutMs={gameState.turnTimeoutMs ?? 30000} />
          )}
          {!connected && (
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
              {gameState.handles?.[selectedUnit] ?? unitLabels[selectedUnit] ?? selectedUnit} PoV ✕
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

      {/* Main content area — stacks on mobile */}
      <div className="flex flex-col md:flex-row gap-2 flex-1 min-h-0 md:overflow-hidden">
        {/* Hex grid */}
        <div className="flex-1 bg-gray-900/50 rounded-lg p-1 flex items-center justify-center min-w-0 aspect-square md:aspect-auto md:min-h-0 overflow-hidden relative">
          {gameState.phase === 'finished' && (
            <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/60 backdrop-blur-sm rounded-lg">
              <div className="text-center px-8 py-6">
                {gameState.winner ? (
                  <>
                    <div className="text-5xl md:text-7xl font-black mb-3" style={{ color: gameState.winner === 'A' ? '#60a5fa' : '#f87171' }}>
                      {gameState.winner === 'A' ? '🔵' : '🔴'} TEAM {gameState.winner} WINS!
                    </div>
                    <div className="text-xl md:text-2xl text-gray-300 font-medium">
                      captured the lobster 🦞
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
          {gameState.turn === 0 && gameState.phase !== 'finished' && (
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
            mapRadius={gameState.mapRadius}
            selectedTeam={selectedTeam}
            visibleA={gameState.visibleA}
            visibleB={gameState.visibleB}
            visibleOverride={selectedUnit && gameState.visibleByUnit?.[selectedUnit] ? gameState.visibleByUnit[selectedUnit] : undefined}
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

        {/* Sidebar — stacks vertically on mobile and desktop */}
        <div className="flex flex-col gap-2 md:w-52 shrink-0 min-h-0 overflow-hidden">
          {/* Kill feed */}
          <div className="bg-gray-900 rounded-lg p-3 flex flex-col gap-2 max-h-32 md:max-h-[40%] overflow-hidden">
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
              Kills
            </h3>
            <div className="overflow-y-auto flex-1">
              <KillFeed kills={allKills} />
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

          {/* Pre-game / Lobby chat (collapsible) */}
          {(() => {
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
          <span className="text-lg sm:text-2xl">🦞</span>
          <span className="text-blue-400 font-semibold">A:</span>
          <span className="text-gray-300">{gameState.flagA.status}</span>
        </div>
        <div className="flex items-center gap-1 sm:gap-2">
          <span className="text-red-400 font-semibold">B:</span>
          <span className="text-gray-300">{gameState.flagB.status}</span>
          <span className="text-lg sm:text-2xl">🦞</span>
        </div>
      </div>
    </div>
  );
}
