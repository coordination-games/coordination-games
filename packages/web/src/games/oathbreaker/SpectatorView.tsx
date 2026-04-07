import { useState, useEffect, useRef } from 'react';
import type { SpectatorViewProps } from '../types';

// ---------------------------------------------------------------------------
// Types — mirrors the SpectatorView from game.ts (no import from game pkg)
// ---------------------------------------------------------------------------

interface OathPlayer {
  id: string;
  dollarValue: number;
  breakEvenDelta: number;
  cooperationRate: number;
  oathsKept: number;
  oathsBroken: number;
}

interface OathSpectatorPairing {
  player1: string;
  player2: string;
  phase: 'pledging' | 'deciding' | 'decided';
  proposal1: number | null;
  proposal2: number | null;
  agreedPledge: number | null;
  player1HasDecided: boolean;
  player2HasDecided: boolean;
}

interface OathPairingResult {
  player1: string;
  player2: string;
  move1: 'C' | 'D';
  move2: 'C' | 'D';
  pledge: number;
  delta1: number;
  delta2: number;
  outcome: 'cooperation' | 'betrayal_1' | 'betrayal_2' | 'standoff';
}

interface OathSpectatorState {
  round: number;
  maxRounds: number;
  phase: 'playing' | 'finished';
  players: OathPlayer[];
  pairings: OathSpectatorPairing[];
  roundResults: OathPairingResult[][];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapServerState(raw: any): OathSpectatorState | null {
  if (!raw) return null;
  const data = raw.data ?? raw;
  if (!data.players || !Array.isArray(data.players)) return null;
  return {
    round: data.round ?? 0,
    maxRounds: data.maxRounds ?? 12,
    phase: data.phase ?? 'playing',
    players: data.players,
    pairings: data.pairings ?? [],
    roundResults: data.roundResults ?? [],
  };
}

function formatDollar(v: number): string {
  if (v >= 0) return `+$${v.toFixed(2)}`;
  return `-$${Math.abs(v).toFixed(2)}`;
}

function formatDollarAbs(v: number): string {
  return `$${v.toFixed(2)}`;
}

function outcomeLabel(outcome: string): string {
  switch (outcome) {
    case 'cooperation': return 'OATH HONORED';
    case 'betrayal_1': return 'PLAYER 1 BREAKS OATH';
    case 'betrayal_2': return 'PLAYER 2 BREAKS OATH';
    case 'standoff': return 'BOTH FORSWORN';
    default: return outcome;
  }
}

function outcomeColor(outcome: string): string {
  switch (outcome) {
    case 'cooperation': return '#4ade80';
    case 'betrayal_1':
    case 'betrayal_2': return '#f87171';
    case 'standoff': return '#fbbf24';
    default: return '#9ca3af';
  }
}

function moveLabel(move: 'C' | 'D'): string {
  return move === 'C' ? 'COOPERATE' : 'DEFECT';
}

function moveColor(move: 'C' | 'D'): string {
  return move === 'C' ? '#4ade80' : '#f87171';
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function HealthBar({ dollarValue, breakEvenDelta }: { dollarValue: number; breakEvenDelta: number }) {
  // Bar centered on break-even. Range: -1 to +1 roughly.
  const maxDelta = 1.0;
  const clampedDelta = Math.max(-maxDelta, Math.min(maxDelta, breakEvenDelta));
  const pct = ((clampedDelta / maxDelta) * 50) + 50; // 0-100, 50 = break-even

  const barColor = breakEvenDelta >= 0
    ? 'linear-gradient(90deg, transparent, transparent 50%, #3b82f6 50%, #eab308)'
    : 'linear-gradient(90deg, #ef4444, #ef4444 50%, transparent 50%, transparent)';

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
      <span style={{ fontSize: 11, fontFamily: 'monospace', color: '#9ca3af', width: 48, textAlign: 'right', flexShrink: 0 }}>
        {formatDollarAbs(dollarValue)}
      </span>
      <div style={{
        flex: 1,
        height: 10,
        background: '#1f2937',
        borderRadius: 5,
        position: 'relative',
        overflow: 'hidden',
        border: '1px solid #374151',
      }}>
        {/* Center line (break-even) */}
        <div style={{
          position: 'absolute',
          left: '50%',
          top: 0,
          bottom: 0,
          width: 1,
          background: '#6b7280',
          zIndex: 2,
        }} />
        {/* Filled portion */}
        {breakEvenDelta >= 0 ? (
          <div style={{
            position: 'absolute',
            left: '50%',
            top: 0,
            bottom: 0,
            width: `${pct - 50}%`,
            background: 'linear-gradient(90deg, #3b82f6, #eab308)',
            borderRadius: '0 5px 5px 0',
            transition: 'width 0.5s ease',
          }} />
        ) : (
          <div style={{
            position: 'absolute',
            right: '50%',
            top: 0,
            bottom: 0,
            width: `${50 - pct}%`,
            background: '#ef4444',
            borderRadius: '5px 0 0 5px',
            transition: 'width 0.5s ease',
          }} />
        )}
      </div>
      <span style={{
        fontSize: 11,
        fontFamily: 'monospace',
        color: breakEvenDelta >= 0 ? '#4ade80' : '#f87171',
        width: 52,
        flexShrink: 0,
      }}>
        {formatDollar(breakEvenDelta)}
      </span>
    </div>
  );
}

function AgentCard({
  player,
  handles,
  pairing,
  isActive,
  onClick,
}: {
  player: OathPlayer;
  handles: Record<string, string>;
  pairing?: OathSpectatorPairing;
  isActive: boolean;
  onClick: () => void;
}) {
  const name = handles[player.id] ?? player.id;
  const totalOaths = player.oathsKept + player.oathsBroken;
  const coopPct = totalOaths > 0 ? Math.round(player.cooperationRate * 100) : 100;

  let status = 'Waiting';
  if (pairing) {
    const opponentId = pairing.player1 === player.id ? pairing.player2 : pairing.player1;
    const opponentName = handles[opponentId] ?? opponentId;
    if (pairing.phase === 'pledging') status = `Negotiating with ${opponentName}`;
    else if (pairing.phase === 'deciding') status = `Deciding vs ${opponentName}`;
    else if (pairing.phase === 'decided') status = `Sealed vs ${opponentName}`;
  }

  return (
    <button
      onClick={onClick}
      style={{
        background: isActive ? '#1e293b' : '#111827',
        border: isActive ? '1px solid #3b82f6' : '1px solid #1f2937',
        borderRadius: 10,
        padding: '12px 14px',
        cursor: 'pointer',
        textAlign: 'left',
        width: '100%',
        transition: 'all 0.2s',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <span style={{ fontWeight: 700, fontSize: 13, color: '#e5e7eb', letterSpacing: 0.5 }}>{name}</span>
        <span style={{
          fontSize: 10,
          fontFamily: 'monospace',
          padding: '2px 6px',
          borderRadius: 4,
          background: pairing ? 'rgba(59, 130, 246, 0.15)' : 'rgba(107, 114, 128, 0.15)',
          color: pairing ? '#60a5fa' : '#6b7280',
        }}>
          {pairing ? 'IN BATTLE' : 'IDLE'}
        </span>
      </div>
      <HealthBar dollarValue={player.dollarValue} breakEvenDelta={player.breakEvenDelta} />
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, fontSize: 11, color: '#6b7280' }}>
        <span>
          Oaths: <span style={{ color: '#4ade80' }}>{player.oathsKept}</span>/<span style={{ color: '#f87171' }}>{player.oathsBroken}</span>
          {' '}({coopPct}%)
        </span>
        <span style={{ fontSize: 10, color: '#4b5563' }}>{status}</span>
      </div>
    </button>
  );
}

function PairingPhaseIndicator({ pairing }: { pairing: OathSpectatorPairing }) {
  const phaseStyles: Record<string, { bg: string; color: string; label: string }> = {
    pledging: { bg: 'rgba(234, 179, 8, 0.15)', color: '#eab308', label: 'NEGOTIATING PLEDGE' },
    deciding: { bg: 'rgba(59, 130, 246, 0.15)', color: '#60a5fa', label: 'DECISIONS SEALED' },
    decided: { bg: 'rgba(74, 222, 128, 0.15)', color: '#4ade80', label: 'BOTH DECIDED' },
  };
  const s = phaseStyles[pairing.phase] ?? phaseStyles.pledging;
  return (
    <span style={{
      fontSize: 10,
      fontWeight: 700,
      letterSpacing: 1.5,
      padding: '3px 10px',
      borderRadius: 4,
      background: s.bg,
      color: s.color,
    }}>
      {s.label}
    </span>
  );
}

function BattleView({
  pairing,
  handles,
  players,
  chatMessages,
  roundResults,
  currentRound,
  onBack,
}: {
  pairing: OathSpectatorPairing;
  handles: Record<string, string>;
  players: OathPlayer[];
  chatMessages: { from: string; message: string; timestamp: number }[];
  roundResults: OathPairingResult[][];
  currentRound: number;
  onBack: () => void;
}) {
  const chatRef = useRef<HTMLDivElement>(null);
  const p1 = players.find(p => p.id === pairing.player1);
  const p2 = players.find(p => p.id === pairing.player2);
  if (!p1 || !p2) return null;

  const name1 = handles[p1.id] ?? p1.id;
  const name2 = handles[p2.id] ?? p2.id;

  // Find previous results between these two
  const historyResults: OathPairingResult[] = [];
  for (const roundRes of roundResults) {
    for (const r of roundRes) {
      if ((r.player1 === p1.id && r.player2 === p2.id) || (r.player1 === p2.id && r.player2 === p1.id)) {
        historyResults.push(r);
      }
    }
  }

  // Filter chat to these two players
  const battleChat = chatMessages.filter(
    m => m.from === p1.id || m.from === p2.id
  );

  useEffect(() => {
    if (chatRef.current) {
      chatRef.current.scrollTop = chatRef.current.scrollHeight;
    }
  }, [battleChat.length]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, height: '100%' }}>
      {/* Header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        background: '#0f172a',
        borderRadius: 8,
        padding: '10px 16px',
      }}>
        <button
          onClick={onBack}
          style={{
            background: '#1e293b',
            border: '1px solid #334155',
            borderRadius: 6,
            padding: '4px 12px',
            color: '#9ca3af',
            fontSize: 12,
            cursor: 'pointer',
          }}
        >
          Back to Overview
        </button>
        <PairingPhaseIndicator pairing={pairing} />
        <span style={{ fontSize: 11, fontFamily: 'monospace', color: '#6b7280' }}>
          Round {currentRound}
        </span>
      </div>

      {/* Fighters */}
      <div style={{
        display: 'flex',
        gap: 16,
        alignItems: 'stretch',
      }}>
        {/* Player 1 */}
        <div style={{
          flex: 1,
          background: '#0f172a',
          borderRadius: 8,
          padding: 16,
          border: '1px solid #1e293b',
        }}>
          <div style={{ fontWeight: 700, fontSize: 15, color: '#e5e7eb', marginBottom: 8 }}>{name1}</div>
          <HealthBar dollarValue={p1.dollarValue} breakEvenDelta={p1.breakEvenDelta} />
          <div style={{ fontSize: 11, color: '#6b7280', marginTop: 6 }}>
            Oaths kept: {p1.oathsKept} | Broken: {p1.oathsBroken}
          </div>
        </div>

        {/* VS divider */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          width: 50,
        }}>
          <span style={{
            fontWeight: 900,
            fontSize: 18,
            color: '#374151',
            letterSpacing: 2,
          }}>VS</span>
        </div>

        {/* Player 2 */}
        <div style={{
          flex: 1,
          background: '#0f172a',
          borderRadius: 8,
          padding: 16,
          border: '1px solid #1e293b',
        }}>
          <div style={{ fontWeight: 700, fontSize: 15, color: '#e5e7eb', marginBottom: 8 }}>{name2}</div>
          <HealthBar dollarValue={p2.dollarValue} breakEvenDelta={p2.breakEvenDelta} />
          <div style={{ fontSize: 11, color: '#6b7280', marginTop: 6 }}>
            Oaths kept: {p2.oathsKept} | Broken: {p2.oathsBroken}
          </div>
        </div>
      </div>

      {/* Pledge negotiation */}
      <div style={{
        background: '#0f172a',
        borderRadius: 8,
        padding: 14,
        border: '1px solid #1e293b',
      }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: '#6b7280', letterSpacing: 1.5, marginBottom: 8, textTransform: 'uppercase' }}>
          Pledge Negotiation
        </div>
        <div style={{ display: 'flex', gap: 16, marginBottom: 8 }}>
          <div style={{ flex: 1 }}>
            <span style={{ fontSize: 11, color: '#9ca3af' }}>{name1}: </span>
            {pairing.proposal1 !== null ? (
              <span style={{ fontFamily: 'monospace', fontSize: 13, fontWeight: 700, color: '#eab308' }}>
                {pairing.proposal1} pts
              </span>
            ) : (
              <span style={{ fontSize: 11, color: '#4b5563', fontStyle: 'italic' }}>thinking...</span>
            )}
          </div>
          <div style={{ flex: 1 }}>
            <span style={{ fontSize: 11, color: '#9ca3af' }}>{name2}: </span>
            {pairing.proposal2 !== null ? (
              <span style={{ fontFamily: 'monospace', fontSize: 13, fontWeight: 700, color: '#eab308' }}>
                {pairing.proposal2} pts
              </span>
            ) : (
              <span style={{ fontSize: 11, color: '#4b5563', fontStyle: 'italic' }}>thinking...</span>
            )}
          </div>
        </div>
        {pairing.agreedPledge !== null && (
          <div style={{
            background: 'rgba(234, 179, 8, 0.1)',
            border: '1px solid rgba(234, 179, 8, 0.3)',
            borderRadius: 6,
            padding: '6px 12px',
            textAlign: 'center',
            fontSize: 12,
            fontWeight: 700,
            color: '#eab308',
            letterSpacing: 1,
          }}>
            OATH SWORN -- {pairing.agreedPledge} points on the line
          </div>
        )}
        {pairing.phase === 'deciding' && (
          <div style={{ display: 'flex', gap: 16, marginTop: 8 }}>
            <div style={{ flex: 1, textAlign: 'center' }}>
              <span style={{
                fontSize: 10,
                fontWeight: 700,
                padding: '2px 8px',
                borderRadius: 4,
                background: pairing.player1HasDecided ? 'rgba(74, 222, 128, 0.15)' : 'rgba(107, 114, 128, 0.1)',
                color: pairing.player1HasDecided ? '#4ade80' : '#4b5563',
              }}>
                {pairing.player1HasDecided ? 'SEALED' : 'DECIDING...'}
              </span>
            </div>
            <div style={{ flex: 1, textAlign: 'center' }}>
              <span style={{
                fontSize: 10,
                fontWeight: 700,
                padding: '2px 8px',
                borderRadius: 4,
                background: pairing.player2HasDecided ? 'rgba(74, 222, 128, 0.15)' : 'rgba(107, 114, 128, 0.1)',
                color: pairing.player2HasDecided ? '#4ade80' : '#4b5563',
              }}>
                {pairing.player2HasDecided ? 'SEALED' : 'DECIDING...'}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Chat */}
      <div style={{
        flex: 1,
        background: '#0f172a',
        borderRadius: 8,
        padding: 14,
        border: '1px solid #1e293b',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        overflow: 'hidden',
      }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: '#6b7280', letterSpacing: 1.5, marginBottom: 8, textTransform: 'uppercase' }}>
          Negotiation Chat
        </div>
        <div
          ref={chatRef}
          style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}
        >
          {battleChat.length === 0 && (
            <span style={{ fontSize: 11, color: '#374151', fontStyle: 'italic' }}>No messages yet</span>
          )}
          {battleChat.map((m, i) => {
            const senderName = handles[m.from] ?? m.from;
            const isP1 = m.from === p1.id;
            return (
              <div key={i} style={{ fontSize: 12 }}>
                <span style={{ fontWeight: 600, color: isP1 ? '#60a5fa' : '#f87171' }}>{senderName}:</span>{' '}
                <span style={{ color: '#d1d5db' }}>{m.message}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* History between these two */}
      {historyResults.length > 0 && (
        <div style={{
          background: '#0f172a',
          borderRadius: 8,
          padding: 14,
          border: '1px solid #1e293b',
          maxHeight: 160,
          overflowY: 'auto',
        }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: '#6b7280', letterSpacing: 1.5, marginBottom: 8, textTransform: 'uppercase' }}>
            Previous Encounters
          </div>
          {historyResults.map((r, i) => {
            const rP1IsOurs = r.player1 === p1.id;
            const m1 = rP1IsOurs ? r.move1 : r.move2;
            const m2 = rP1IsOurs ? r.move2 : r.move1;
            const d1 = rP1IsOurs ? r.delta1 : r.delta2;
            const d2 = rP1IsOurs ? r.delta2 : r.delta1;
            return (
              <div key={i} style={{
                display: 'flex',
                gap: 12,
                fontSize: 11,
                padding: '4px 0',
                borderBottom: i < historyResults.length - 1 ? '1px solid #1f2937' : 'none',
              }}>
                <span style={{ color: '#4b5563', width: 20, flexShrink: 0 }}>R{i + 1}</span>
                <span style={{ color: moveColor(m1), fontWeight: 600 }}>{name1}: {moveLabel(m1)}</span>
                <span style={{ color: moveColor(m2), fontWeight: 600 }}>{name2}: {moveLabel(m2)}</span>
                <span style={{ color: d1 >= 0 ? '#4ade80' : '#f87171', fontFamily: 'monospace' }}>
                  {formatDollar(d1)}
                </span>
                <span style={{ color: d2 >= 0 ? '#4ade80' : '#f87171', fontFamily: 'monospace' }}>
                  {formatDollar(d2)}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function RoundResultsPanel({
  roundResults,
  handles,
  currentRound,
}: {
  roundResults: OathPairingResult[][];
  handles: Record<string, string>;
  currentRound: number;
}) {
  const [selectedRound, setSelectedRound] = useState<number | null>(null);

  const displayRound = selectedRound ?? roundResults.length - 1;
  const results = roundResults[displayRound];

  if (!results || results.length === 0) return null;

  return (
    <div style={{
      background: '#0f172a',
      borderRadius: 8,
      padding: 14,
      border: '1px solid #1e293b',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <span style={{ fontSize: 10, fontWeight: 700, color: '#6b7280', letterSpacing: 1.5, textTransform: 'uppercase' }}>
          Round {displayRound + 1} Results
        </span>
        <div style={{ display: 'flex', gap: 4 }}>
          {roundResults.map((_, i) => (
            <button
              key={i}
              onClick={() => setSelectedRound(i)}
              style={{
                width: 20,
                height: 20,
                fontSize: 9,
                fontFamily: 'monospace',
                borderRadius: 4,
                border: 'none',
                cursor: 'pointer',
                background: i === displayRound ? '#3b82f6' : '#1f2937',
                color: i === displayRound ? '#fff' : '#6b7280',
              }}
            >
              {i + 1}
            </button>
          ))}
        </div>
      </div>
      {results.map((r, i) => {
        const n1 = handles[r.player1] ?? r.player1;
        const n2 = handles[r.player2] ?? r.player2;
        return (
          <div key={i} style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '6px 0',
            borderBottom: i < results.length - 1 ? '1px solid #1f2937' : 'none',
            fontSize: 12,
          }}>
            <span style={{ color: moveColor(r.move1), fontWeight: 600, minWidth: 80 }}>
              {n1}
            </span>
            <span style={{
              fontSize: 9,
              fontWeight: 700,
              padding: '1px 6px',
              borderRadius: 3,
              background: moveColor(r.move1) + '22',
              color: moveColor(r.move1),
            }}>{r.move1}</span>
            <span style={{ color: '#374151', fontSize: 10 }}>vs</span>
            <span style={{
              fontSize: 9,
              fontWeight: 700,
              padding: '1px 6px',
              borderRadius: 3,
              background: moveColor(r.move2) + '22',
              color: moveColor(r.move2),
            }}>{r.move2}</span>
            <span style={{ color: moveColor(r.move2), fontWeight: 600, minWidth: 80 }}>
              {n2}
            </span>
            <span style={{ flex: 1 }} />
            <span style={{
              fontSize: 9,
              fontWeight: 700,
              color: outcomeColor(r.outcome),
              letterSpacing: 0.5,
            }}>
              {outcomeLabel(r.outcome)}
            </span>
            <span style={{ fontFamily: 'monospace', fontSize: 11, color: r.delta1 >= 0 ? '#4ade80' : '#f87171' }}>
              {formatDollar(r.delta1)}
            </span>
            <span style={{ fontFamily: 'monospace', fontSize: 11, color: r.delta2 >= 0 ? '#4ade80' : '#f87171' }}>
              {formatDollar(r.delta2)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main SpectatorView
// ---------------------------------------------------------------------------

export function OathbreakerSpectatorView(props: SpectatorViewProps) {
  const { gameId, handles, chatMessages } = props;

  const [state, setState] = useState<OathSpectatorState | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedPairing, setSelectedPairing] = useState<number | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  // Fetch initial state + connect WebSocket
  useEffect(() => {
    if (!gameId) return;

    fetch(`/api/games/${gameId}`)
      .then(r => r.json())
      .then(data => {
        const mapped = mapServerState(data);
        if (mapped) setState(mapped);
      })
      .catch(() => {});

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws/game/${gameId}`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => { setConnected(true); setError(null); };
    ws.onmessage = (event) => {
      try {
        const raw = JSON.parse(event.data);
        const mapped = mapServerState(raw);
        if (mapped) setState(mapped);
      } catch {
        console.warn('Failed to parse OATHBREAKER WS message');
      }
    };
    ws.onerror = () => setError('WebSocket error');
    ws.onclose = () => setConnected(false);

    return () => { ws.close(); wsRef.current = null; };
  }, [gameId]);

  if (!state) {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: 'calc(100vh - 5rem)',
      }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 36, marginBottom: 12 }}>&#9876;</div>
          <p style={{ color: '#9ca3af' }}>
            {error ? error : connected ? 'Waiting for game data...' : `Connecting to game ${gameId}...`}
          </p>
        </div>
      </div>
    );
  }

  // Build pairing lookup per player
  const playerPairing = new Map<string, number>();
  state.pairings.forEach((p, i) => {
    playerPairing.set(p.player1, i);
    playerPairing.set(p.player2, i);
  });

  // Sort players by dollar value descending
  const sortedPlayers = [...state.players].sort((a, b) => b.dollarValue - a.dollarValue);

  // If we're viewing a specific battle
  if (selectedPairing !== null && selectedPairing < state.pairings.length) {
    return (
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        height: 'calc(100vh - 5rem)',
        margin: '-1rem -1.5rem -2rem',
        padding: '8px 16px 12px',
        gap: 8,
        background: '#030712',
      }}>
        <BattleView
          pairing={state.pairings[selectedPairing]}
          handles={handles}
          players={state.players}
          chatMessages={chatMessages}
          roundResults={state.roundResults}
          currentRound={state.round}
          onBack={() => setSelectedPairing(null)}
        />
      </div>
    );
  }

  // Tournament overview
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: 'calc(100vh - 5rem)',
      margin: '-1rem -1.5rem -2rem',
      padding: '8px 16px 12px',
      gap: 8,
      background: '#030712',
    }}>
      {/* Top bar */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        background: '#111827',
        borderRadius: 8,
        padding: '10px 16px',
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <span style={{ fontWeight: 700, fontSize: 14, color: '#e5e7eb' }}>
            OATHBREAKER
          </span>
          <span style={{ fontSize: 12, fontFamily: 'monospace', color: '#9ca3af' }}>
            Round {state.round}/{state.maxRounds}
          </span>
          {state.phase === 'playing' && (
            <span style={{
              fontSize: 10,
              fontWeight: 600,
              padding: '2px 8px',
              borderRadius: 4,
              background: 'rgba(74, 222, 128, 0.15)',
              color: '#4ade80',
            }}>
              LIVE
            </span>
          )}
          {state.phase === 'finished' && (
            <span style={{
              fontSize: 10,
              fontWeight: 700,
              padding: '2px 8px',
              borderRadius: 4,
              background: 'rgba(234, 179, 8, 0.15)',
              color: '#eab308',
              letterSpacing: 1,
            }}>
              FINISHED
            </span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {!connected && (
            <span style={{ fontSize: 11, color: '#eab308' }}>disconnected</span>
          )}
          <span style={{ fontSize: 11, fontFamily: 'monospace', color: '#4b5563' }}>
            {state.players.length} players
          </span>
        </div>
      </div>

      {/* Main content: grid + results */}
      <div style={{ display: 'flex', flex: 1, gap: 8, minHeight: 0, overflow: 'hidden' }}>
        {/* Agent grid */}
        <div style={{
          flex: 1,
          overflowY: 'auto',
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
          gap: 8,
          alignContent: 'start',
          padding: '4px 0',
        }}>
          {sortedPlayers.map((player, i) => {
            const pairingIdx = playerPairing.get(player.id);
            const pairing = pairingIdx !== undefined ? state.pairings[pairingIdx] : undefined;
            return (
              <AgentCard
                key={player.id}
                player={player}
                handles={handles}
                pairing={pairing}
                isActive={pairingIdx !== undefined}
                onClick={() => {
                  if (pairingIdx !== undefined) {
                    setSelectedPairing(pairingIdx);
                  }
                }}
              />
            );
          })}
        </div>

        {/* Sidebar: round results + active pairings */}
        <div style={{
          width: 340,
          flexShrink: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          overflowY: 'auto',
          minHeight: 0,
        }}>
          {/* Active pairings */}
          {state.pairings.length > 0 && (
            <div style={{
              background: '#0f172a',
              borderRadius: 8,
              padding: 14,
              border: '1px solid #1e293b',
            }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: '#6b7280', letterSpacing: 1.5, marginBottom: 10, textTransform: 'uppercase' }}>
                Active Battles
              </div>
              {state.pairings.map((p, i) => {
                const n1 = handles[p.player1] ?? p.player1;
                const n2 = handles[p.player2] ?? p.player2;
                return (
                  <button
                    key={i}
                    onClick={() => setSelectedPairing(i)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      width: '100%',
                      background: '#111827',
                      border: '1px solid #1f2937',
                      borderRadius: 6,
                      padding: '8px 10px',
                      marginBottom: i < state.pairings.length - 1 ? 6 : 0,
                      cursor: 'pointer',
                      textAlign: 'left',
                    }}
                  >
                    <span style={{ fontSize: 12, color: '#e5e7eb' }}>
                      {n1} <span style={{ color: '#374151' }}>vs</span> {n2}
                    </span>
                    <PairingPhaseIndicator pairing={p} />
                  </button>
                );
              })}
            </div>
          )}

          {/* Round results */}
          <RoundResultsPanel
            roundResults={state.roundResults}
            handles={handles}
            currentRound={state.round}
          />
        </div>
      </div>

      {/* Game finished overlay */}
      {state.phase === 'finished' && sortedPlayers.length > 0 && (
        <div style={{
          background: '#111827',
          borderRadius: 8,
          padding: '12px 16px',
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 16,
          border: '1px solid rgba(234, 179, 8, 0.3)',
        }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: '#eab308', letterSpacing: 1 }}>WINNER</span>
          <span style={{ fontSize: 14, fontWeight: 700, color: '#e5e7eb' }}>
            {handles[sortedPlayers[0].id] ?? sortedPlayers[0].id}
          </span>
          <span style={{ fontFamily: 'monospace', fontSize: 13, color: '#4ade80' }}>
            {formatDollarAbs(sortedPlayers[0].dollarValue)}
          </span>
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 11, color: '#6b7280' }}>
            {state.round} rounds played
          </span>
        </div>
      )}
    </div>
  );
}
