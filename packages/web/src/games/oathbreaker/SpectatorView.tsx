import { useState, useEffect, useRef, useMemo } from 'react';
import { API_BASE, getWsUrl } from '../../config.js';
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
  const { gameId, handles, chatMessages, gameState: rawGameState, replaySnapshots, prevGameState: rawPrevGameState, animate } = props;
  const isReplay = replaySnapshots != null;

  const [liveState, setLiveState] = useState<OathSpectatorState | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [followedPlayerId, setFollowedPlayerId] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  // ---------------------------------------------------------------------------
  // Replay mode: derive state from props
  // ---------------------------------------------------------------------------

  const replayState = useMemo(() => {
    if (!isReplay || !rawGameState) return null;
    return mapServerState(rawGameState);
  }, [isReplay, rawGameState]);

  const prevReplayState = useMemo(() => {
    if (!isReplay || !rawPrevGameState) return null;
    return mapServerState(rawPrevGameState);
  }, [isReplay, rawPrevGameState]);

  // ---------------------------------------------------------------------------
  // Live mode: fetch initial state + connect WebSocket
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (isReplay || !gameId) return;

    fetch(`${API_BASE}/games/${gameId}`)
      .then(r => r.json())
      .then(data => {
        const mapped = mapServerState(data);
        if (mapped) setLiveState(mapped);
      })
      .catch(() => {});

    const wsUrl = getWsUrl(`/ws/game/${gameId}`);
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => { setConnected(true); setError(null); };
    ws.onmessage = (event) => {
      try {
        const raw = JSON.parse(event.data);
        const mapped = mapServerState(raw);
        if (mapped) setLiveState(mapped);
      } catch {
        console.warn('Failed to parse OATHBREAKER WS message');
      }
    };
    ws.onerror = () => setError('WebSocket error');
    ws.onclose = () => setConnected(false);

    return () => { ws.close(); wsRef.current = null; };
  }, [gameId, isReplay]);

  // ---------------------------------------------------------------------------
  // Unified state: replay or live
  // ---------------------------------------------------------------------------

  const state = isReplay ? replayState : liveState;
  const prevState = isReplay ? prevReplayState : null;

  // Detect new round results for animation triggering
  const shouldAnimate = animate !== false;
  const newRoundResults = useMemo(() => {
    if (!state || !prevState) return null;
    // New results appeared if current has more rounds of results
    if (state.roundResults.length > prevState.roundResults.length) {
      return state.roundResults[state.roundResults.length - 1] ?? null;
    }
    return null;
  }, [state, prevState]);

  // Character assignments — seeded, deterministic
  const characters = useMemo(() => {
    if (!state) return {};
    const playerIds = state.players.map(p => p.id).sort();
    return assignCharacters(playerIds, gameId ?? 'default');
  }, [state?.players.length, gameId]);

  if (!state) {
    return (
      <div className="arcade-screen" style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        height: '100%',
      }}>
        <div style={{ textAlign: 'center' }}>
          <div className="pixel-text" style={{ fontSize: 14, color: '#e9d852', letterSpacing: 4, marginBottom: 16 }}>
            OATHBREAKER
          </div>
          <img src="/assets/oathbreaker/kanji-title-pixel.png" alt="&#35475;&#32004;&#30772;&#12426;" style={{ height: 80, marginTop: 6, imageRendering: 'pixelated' }} />
          <div className="pixel-text" style={{ fontSize: 9, color: '#d1d5db', marginBottom: 8, letterSpacing: 3 }}>Seiyaku-yaburi</div>
          <p className="pixel-text" style={{ fontSize: 8, color: '#e5e7eb' }}>
            {error ? error : isReplay ? 'LOADING REPLAY...' : connected ? 'WAITING FOR GAME DATA...' : 'CONNECTING...'}
          </p>
        </div>
      </div>
    );
  }

  // Resolve followed player to their current pairing
  const rawPairing = followedPlayerId
    ? state.pairings.find(
        p => p.player1 === followedPlayerId || p.player2 === followedPlayerId
      ) ?? null
    : null;
  const livePairing = rawPairing && rawPairing.player2 === followedPlayerId
    ? {
        ...rawPairing,
        player1: rawPairing.player2,
        player2: rawPairing.player1,
        proposal1: rawPairing.proposal2,
        proposal2: rawPairing.proposal1,
        player1HasDecided: rawPairing.player2HasDecided,
        player2HasDecided: rawPairing.player1HasDecided,
      }
    : rawPairing;

  // Battle view
  if (livePairing) {
    return (
      <div style={{ height: '100%' }}>
        <ArcadeBattleView
          pairing={livePairing}
          handles={handles}
          players={state.players}
          characters={characters}
          chatMessages={chatMessages}
          roundResults={state.roundResults}
          currentRound={state.round}
          maxRounds={state.maxRounds}
          followedPlayerId={followedPlayerId}
          onBack={() => setFollowedPlayerId(null)}
          animate={shouldAnimate}
          newRoundResults={newRoundResults}
        />
      </div>
    );
  }

  // Tournament overview
  return (
    <div style={{ height: '100%' }}>
      <ArcadeOverview
        players={state.players}
        pairings={state.pairings}
        handles={handles}
        characters={characters}
        currentRound={state.round}
        maxRounds={state.maxRounds}
        phase={state.phase}
        onSelectPlayer={(playerId) => setFollowedPlayerId(playerId)}
      />
    </div>
  );
}
