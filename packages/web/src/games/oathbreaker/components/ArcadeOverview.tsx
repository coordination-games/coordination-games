import type { CharacterAssignment } from '../utils/characterAssignment';
import { CharacterSprite } from './CharacterSprite';
import { HealthBar } from './HealthBar';

// ---- Types ----

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

// ---- Card component ----

function AgentCard({
  player,
  handles,
  characters,
  pairing,
  onClick,
}: {
  player: OathPlayer;
  handles: Record<string, string>;
  characters: Record<string, CharacterAssignment>;
  pairing?: OathSpectatorPairing;
  onClick: () => void;
}) {
  const name = handles[player.id] ?? player.id.slice(0, 8);
  const char = characters[player.id];
  const totalOaths = player.oathsKept + player.oathsBroken;
  const inBattle = !!pairing;

  let status = 'IDLE';
  if (pairing) {
    const opId = pairing.player1 === player.id ? pairing.player2 : pairing.player1;
    const opName = handles[opId] ?? opId.slice(0, 8);
    if (pairing.phase === 'pledging') status = `VS ${opName}`;
    else if (pairing.phase === 'deciding') status = `OATH SWORN`;
    else status = `SEALED`;
  }

  return (
    <button
      type="button"
      onClick={onClick}
      className={`arcade-card ${inBattle ? 'active' : ''}`}
      style={{ textAlign: 'left', width: '100%' }}
    >
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end' }}>
        {/* Character portrait */}
        <div
          style={{
            width: 64,
            height: 80,
            display: 'flex',
            alignItems: 'flex-end',
            justifyContent: 'center',
            background: '#0a0a0f',
            border: '1px solid #1f2937',
            flexShrink: 0,
            overflow: 'hidden',
          }}
        >
          {/* @ts-expect-error TS2375: Type '{ character: string; pose: "idle"; scale: number; tint: string | null | un — TODO(2.3-followup) */}
          <CharacterSprite
            character={char?.characterName ?? 'buchu'}
            pose="idle"
            scale={2}
            tint={char?.tint}
          />
        </div>

        {/* Stats */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: 6,
            }}
          >
            <span className="pixel-text" style={{ fontSize: 8, color: '#e5e7eb' }}>
              {name}
            </span>
            <span
              className="pixel-text"
              style={{
                fontSize: 6,
                padding: '2px 6px',
                background: inBattle ? 'rgba(59, 130, 246, 0.15)' : 'rgba(107, 114, 128, 0.1)',
                color: inBattle ? '#60a5fa' : '#9ca3af',
              }}
            >
              {status}
            </span>
          </div>

          <HealthBar dollarValue={player.dollarValue} breakEvenDelta={player.breakEvenDelta} />

          <div
            className="pixel-text"
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              marginTop: 4,
              fontSize: 6,
              color: '#d1d5db',
            }}
          >
            <span>
              OATHS: <span style={{ color: '#4ade80' }}>{player.oathsKept}</span>/
              <span style={{ color: '#f87171' }}>{player.oathsBroken}</span>
              {totalOaths > 0 && ` (${Math.round(player.cooperationRate * 100)}%)`}
            </span>
          </div>
        </div>
      </div>
    </button>
  );
}

// ---- Main component ----

interface ArcadeOverviewProps {
  players: OathPlayer[];
  pairings: OathSpectatorPairing[];
  handles: Record<string, string>;
  characters: Record<string, CharacterAssignment>;
  currentRound: number;
  maxRounds: number;
  phase: string;
  onSelectPlayer: (playerId: string) => void;
}

export function ArcadeOverview({
  players,
  pairings,
  handles,
  characters,
  currentRound,
  maxRounds,
  phase,
  onSelectPlayer,
}: ArcadeOverviewProps) {
  // Sort by dollar value descending
  const sorted = [...players].sort((a, b) => b.dollarValue - a.dollarValue);

  const getPairing = (playerId: string) =>
    pairings.find((p) => p.player1 === playerId || p.player2 === playerId);

  return (
    <div
      className="arcade-screen"
      style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: 16 }}
    >
      {/* Title */}
      <div
        style={{
          textAlign: 'center',
          padding: '16px 0 12px',
          borderBottom: '2px solid #1f2937',
          marginBottom: 16,
        }}
      >
        <div
          className="pixel-text"
          style={{
            fontSize: 16,
            color: '#e9d852',
            letterSpacing: 6,
            textShadow: '0 0 12px rgba(233, 216, 82, 0.5)',
          }}
        >
          OATHBREAKER
        </div>
        <img
          src="/assets/oathbreaker/kanji-title-pixel.png"
          alt="誓約破り"
          style={{
            height: 120,
            imageRendering: 'pixelated',
            display: 'block',
            margin: '8px auto 0',
          }}
        />
        <div
          className="pixel-text"
          style={{ fontSize: 10, color: '#d1d5db', marginTop: 6, letterSpacing: 3 }}
        >
          Seiyaku-yaburi
        </div>
        <div className="pixel-text" style={{ fontSize: 8, color: '#e5e7eb', marginTop: 10 }}>
          {phase === 'finished' ? 'TOURNAMENT COMPLETE' : `ROUND ${currentRound} / ${maxRounds}`}
          {'  ·  '}
          {players.length} WARRIORS
        </div>
      </div>

      {/* Agent grid */}
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
          gap: 8,
          alignContent: 'start',
        }}
      >
        {sorted.map((player) => {
          const pairing = getPairing(player.id);
          return (
            <AgentCard
              key={player.id}
              player={player}
              handles={handles}
              characters={characters}
              pairing={pairing as OathSpectatorPairing}
              onClick={() => onSelectPlayer(player.id)}
            />
          );
        })}
      </div>
    </div>
  );
}
