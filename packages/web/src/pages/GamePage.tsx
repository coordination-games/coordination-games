import { useState, useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import HexGrid from '../components/HexGrid';
import type {
  SpectatorGameState,
  KillEvent,
  ChatMessage,
} from '../types';

// ---------------------------------------------------------------------------
// Map server state → frontend types
// ---------------------------------------------------------------------------

function mapServerState(raw: any): SpectatorGameState | null {
  if (!raw) return null;
  // The WS sends { type: 'state_update' | 'game_over', data: {...} }
  const data = raw.data ?? raw;

  if (!data.tiles || !Array.isArray(data.tiles)) return null;

  // Map tiles: server sends type as TileType ('ground'|'wall'|'base_a'|'base_b')
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

  // Map kills: server sends { killerId, victimId, reason }
  // We need to enrich with class/team info from units
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

  // Flag status
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
          <span className={`font-semibold ${teamColor}`}>{m.from}:</span>{' '}
          <span className="text-gray-300">&ldquo;{m.message}&rdquo;</span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// GamePage
// ---------------------------------------------------------------------------

export default function GamePage() {
  const { id } = useParams<{ id: string }>();
  const [selectedTeam, setSelectedTeam] = useState<'A' | 'B' | 'all'>('all');
  const [gameState, setGameState] = useState<SpectatorGameState | null>(null);
  const [allKills, setAllKills] = useState<KillEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  // Fetch initial state via REST, then connect WebSocket for live updates
  useEffect(() => {
    if (!id) return;

    // Fetch initial state
    fetch(`/api/games/${id}`)
      .then((res) => res.json())
      .then((data) => {
        const mapped = mapServerState(data);
        if (mapped) {
          setGameState(mapped);
          if (mapped.kills.length > 0) {
            setAllKills(mapped.kills);
          }
        }
      })
      .catch(() => {});

    // Connect WebSocket
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws/game/${id}`;
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
          setGameState(mapped);
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
  }, [id]);

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
            {error ? error : connected ? 'Waiting for game data...' : `Connecting to game ${id}...`}
          </p>
        </div>
      </div>
    );
  }

  const chatMessages =
    selectedTeam === 'A'
      ? gameState.chatA
      : selectedTeam === 'B'
        ? gameState.chatB
        : [...gameState.chatA, ...gameState.chatB].sort(
            (a, b) => a.turn - b.turn,
          );

  const chatTeamLabel =
    selectedTeam === 'all' ? 'All Chat' : `Team ${selectedTeam} Chat`;

  return (
    <div className="flex flex-col h-[calc(100vh-5rem)] -mx-6 -my-8 px-4 py-3 gap-2">
      {/* Top bar */}
      <div className="flex items-center justify-between bg-gray-900 rounded-lg px-4 py-2 shrink-0">
        <div className="flex items-center gap-4">
          <span className="text-sm text-gray-400">
            Game{' '}
            <span className="font-mono text-emerald-400">{id}</span>
          </span>
          <span className="text-sm font-semibold text-gray-200">
            Turn {gameState.turn}/{gameState.maxTurns}
          </span>
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
      <div className="flex gap-2 flex-1 min-h-0">
        {/* Hex grid — takes most of the space */}
        <div className="flex-1 bg-gray-900/50 rounded-lg p-2 flex items-center justify-center min-w-0">
          <HexGrid
            tiles={gameState.tiles}
            mapRadius={gameState.mapRadius}
            selectedTeam={selectedTeam}
            visibleA={gameState.visibleA}
            visibleB={gameState.visibleB}
          />
        </div>

        {/* Right sidebar */}
        <div className="w-52 shrink-0 flex flex-col gap-2">
          {/* Kill feed */}
          <div className="bg-gray-900 rounded-lg p-3 flex flex-col gap-2 max-h-[40%] overflow-hidden">
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
              Kill Feed
            </h3>
            <div className="overflow-y-auto flex-1 scrollbar-thin">
              <KillFeed kills={allKills} />
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

      {/* Bottom bar — flag status */}
      <div className="flex items-center justify-between bg-gray-900 rounded-lg px-4 py-2 shrink-0">
        <div className="flex items-center gap-2 text-sm">
          <span className="text-2xl">🦞</span>
          <span className="text-blue-400 font-semibold">Team A Flag:</span>
          <span className="text-gray-300">{gameState.flagA.status}</span>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <span className="text-red-400 font-semibold">Team B Flag:</span>
          <span className="text-gray-300">{gameState.flagB.status}</span>
          <span className="text-2xl">🦞</span>
        </div>
      </div>
    </div>
  );
}
