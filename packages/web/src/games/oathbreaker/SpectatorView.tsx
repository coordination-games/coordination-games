import { useState, useEffect, useRef, useMemo } from 'react';
import type { SpectatorViewProps } from '../types';
import { ArcadeBattleView } from './components/ArcadeBattleView';
import { ArcadeOverview } from './components/ArcadeOverview';
import { assignCharacters } from './utils/characterAssignment';
import './styles/arcade.css';

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

// ---------------------------------------------------------------------------
// Main SpectatorView
// ---------------------------------------------------------------------------

export function OathbreakerSpectatorView(props: SpectatorViewProps) {
  const { gameId, handles, chatMessages } = props;

  const [state, setState] = useState<OathSpectatorState | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedPairing, setSelectedPairing] = useState<OathSpectatorPairing | null>(null);
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

  // Character assignments — seeded, deterministic
  const characters = useMemo(() => {
    if (!state) return {};
    const playerIds = state.players.map(p => p.id).sort(); // sort for determinism
    return assignCharacters(playerIds, gameId ?? 'default');
  }, [state?.players.length, gameId]);

  if (!state) {
    return (
      <div className="arcade-screen" style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        height: 'calc(100vh - 5rem)',
      }}>
        <div style={{ textAlign: 'center' }}>
          <div className="pixel-text" style={{ fontSize: 14, color: '#eab308', letterSpacing: 4, marginBottom: 16 }}>
            OATHBREAKER
          </div>
          <div style={{ fontSize: 12, color: '#6b7280' }}>誓約破り</div>
          <div className="pixel-text" style={{ fontSize: 6, color: '#4b5563', marginBottom: 8 }}>Seiyaku-yaburi</div>
          <p className="pixel-text" style={{ fontSize: 8, color: '#9ca3af' }}>
            {error ? error : connected ? 'WAITING FOR GAME DATA...' : 'CONNECTING...'}
          </p>
        </div>
      </div>
    );
  }

  // Update selected pairing from live state (pairings refresh each round)
  const livePairing = selectedPairing
    ? state.pairings.find(
        p => (p.player1 === selectedPairing.player1 && p.player2 === selectedPairing.player2) ||
             (p.player1 === selectedPairing.player2 && p.player2 === selectedPairing.player1)
      ) ?? null
    : null;

  // Battle view
  if (livePairing) {
    return (
      <div style={{
        height: 'calc(100vh - 5rem)',
        margin: '-1rem -1.5rem -2rem',
      }}>
        <ArcadeBattleView
          pairing={livePairing}
          handles={handles}
          players={state.players}
          characters={characters}
          chatMessages={chatMessages}
          roundResults={state.roundResults}
          currentRound={state.round}
          maxRounds={state.maxRounds}
          onBack={() => setSelectedPairing(null)}
        />
      </div>
    );
  }

  // Tournament overview
  return (
    <div style={{
      height: 'calc(100vh - 5rem)',
      margin: '-1rem -1.5rem -2rem',
    }}>
      <ArcadeOverview
        players={state.players}
        pairings={state.pairings}
        handles={handles}
        characters={characters}
        currentRound={state.round}
        maxRounds={state.maxRounds}
        phase={state.phase}
        onSelectPairing={(pairing) => setSelectedPairing(pairing)}
      />
    </div>
  );
}
