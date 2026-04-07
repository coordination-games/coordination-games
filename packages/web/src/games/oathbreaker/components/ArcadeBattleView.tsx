import { useState, useEffect, useRef } from 'react';
import { CharacterSprite } from './CharacterSprite';
import { HealthBar } from './HealthBar';
import type { Pose } from '../utils/spriteMap';
import type { CharacterAssignment } from '../utils/characterAssignment';

// ---- Types (mirrored from SpectatorView) ----

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

// ---- Resolution animation state machine ----

type RevealPhase = 'none' | 'darken' | 'reveal' | 'aftermath';

function useRevealAnimation(result?: OathPairingResult): {
  phase: RevealPhase;
  p1Pose: Pose;
  p2Pose: Pose;
  shakeClass: string;
  flashClass: string;
  showDelta: boolean;
} {
  const [phase, setPhase] = useState<RevealPhase>('none');
  const lastResultRef = useRef<string>('');

  // Serialize result to detect changes
  const resultKey = result
    ? `${result.player1}-${result.player2}-${result.move1}-${result.move2}-${result.pledge}`
    : '';

  useEffect(() => {
    if (!result || resultKey === lastResultRef.current) return;
    lastResultRef.current = resultKey;

    // Start animation sequence
    setPhase('darken');
    const t1 = setTimeout(() => setPhase('reveal'), 1000);
    const t2 = setTimeout(() => setPhase('aftermath'), 3000);
    const t3 = setTimeout(() => setPhase('none'), 5000);

    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); };
  }, [resultKey, result]);

  if (!result || phase === 'none') {
    return { phase: 'none', p1Pose: 'idle', p2Pose: 'idle', shakeClass: '', flashClass: '', showDelta: false };
  }

  if (phase === 'darken') {
    return { phase: 'darken', p1Pose: 'idle', p2Pose: 'idle', shakeClass: '', flashClass: '', showDelta: false };
  }

  const { outcome } = result;
  let p1Pose: Pose = 'idle';
  let p2Pose: Pose = 'idle';
  let shakeClass = '';
  let flashClass = '';

  if (outcome === 'cooperation') {
    p1Pose = 'victory';
    p2Pose = 'victory';
  } else if (outcome === 'betrayal_1') {
    p1Pose = 'attack';
    p2Pose = 'hit';
    shakeClass = 'shake';
    flashClass = 'red-flash';
  } else if (outcome === 'betrayal_2') {
    p1Pose = 'hit';
    p2Pose = 'attack';
    shakeClass = 'shake';
    flashClass = 'red-flash';
  } else if (outcome === 'standoff') {
    p1Pose = 'attack';
    p2Pose = 'attack';
    shakeClass = 'shake';
    flashClass = 'red-flash';
  }

  return {
    phase,
    p1Pose,
    p2Pose,
    shakeClass: phase === 'reveal' ? shakeClass : '',
    flashClass: phase === 'reveal' ? flashClass : '',
    showDelta: phase === 'aftermath',
  };
}

// ---- Sub-components ----

function PhaseBadge({ pairing }: { pairing: OathSpectatorPairing }) {
  const styles: Record<string, { bg: string; color: string; label: string }> = {
    pledging: { bg: 'rgba(234, 179, 8, 0.15)', color: '#eab308', label: 'NEGOTIATING' },
    deciding: { bg: 'rgba(59, 130, 246, 0.15)', color: '#60a5fa', label: 'OATH SWORN' },
    decided: { bg: 'rgba(74, 222, 128, 0.15)', color: '#4ade80', label: 'FATES SEALED' },
  };
  const s = styles[pairing.phase] ?? styles.pledging;

  return (
    <span className="pixel-text" style={{
      fontSize: 7,
      letterSpacing: 2,
      padding: '4px 10px',
      background: s.bg,
      color: s.color,
      border: `1px solid ${s.color}33`,
    }}>
      {s.label}
    </span>
  );
}

function OathBanner({ text, glow }: { text: string; glow?: boolean }) {
  return (
    <div className={glow ? 'oath-glow' : ''} style={{
      textAlign: 'center',
      padding: '8px 16px',
      background: 'rgba(234, 179, 8, 0.1)',
      border: '1px solid rgba(234, 179, 8, 0.3)',
      fontSize: 8,
      fontFamily: "'Press Start 2P', monospace",
      color: '#eab308',
      letterSpacing: 2,
    }}>
      {text}
    </div>
  );
}

function DollarDelta({ delta, side }: { delta: number; side: 'left' | 'right' }) {
  const color = delta >= 0 ? '#4ade80' : '#f87171';
  const text = delta >= 0 ? `+$${delta.toFixed(2)}` : `-$${Math.abs(delta).toFixed(2)}`;

  return (
    <div className="float-up pixel-text" style={{
      position: 'absolute',
      [side]: '20%',
      top: '30%',
      fontSize: 12,
      color,
      fontWeight: 'bold',
      textShadow: `0 0 8px ${color}`,
      zIndex: 10,
    }}>
      {text}
    </div>
  );
}

function OutcomeBanner({ outcome }: { outcome: string }) {
  const labels: Record<string, { text: string; color: string }> = {
    cooperation: { text: 'OATH HONORED', color: '#4ade80' },
    betrayal_1: { text: 'OATH BROKEN', color: '#f87171' },
    betrayal_2: { text: 'OATH BROKEN', color: '#f87171' },
    standoff: { text: 'BOTH FORSWORN', color: '#fbbf24' },
  };
  const l = labels[outcome] ?? labels.cooperation;

  return (
    <div className="fade-in-up pixel-text" style={{
      textAlign: 'center',
      fontSize: 14,
      color: l.color,
      textShadow: `0 0 12px ${l.color}`,
      letterSpacing: 3,
      padding: '12px 0',
    }}>
      {l.text}
    </div>
  );
}

// ---- Main component ----

interface ArcadeBattleViewProps {
  pairing: OathSpectatorPairing;
  handles: Record<string, string>;
  players: OathPlayer[];
  characters: Record<string, CharacterAssignment>;
  chatMessages: { from: string; message: string; timestamp: number }[];
  roundResults: OathPairingResult[][];
  currentRound: number;
  maxRounds: number;
  onBack: () => void;
}

export function ArcadeBattleView({
  pairing,
  handles,
  players,
  characters,
  chatMessages,
  roundResults,
  currentRound,
  maxRounds,
  onBack,
}: ArcadeBattleViewProps) {
  const chatRef = useRef<HTMLDivElement>(null);
  const p1 = players.find(p => p.id === pairing.player1);
  const p2 = players.find(p => p.id === pairing.player2);
  if (!p1 || !p2) return null;

  const name1 = handles[p1.id] ?? p1.id.slice(0, 8);
  const name2 = handles[p2.id] ?? p2.id.slice(0, 8);
  const char1 = characters[p1.id];
  const char2 = characters[p2.id];

  // Find latest result for this pairing
  const latestResult = roundResults.length > 0
    ? roundResults[roundResults.length - 1]?.find(
        r => (r.player1 === p1.id && r.player2 === p2.id) ||
             (r.player1 === p2.id && r.player2 === p1.id)
      )
    : undefined;

  const reveal = useRevealAnimation(latestResult);

  // Determine background
  const bgIdx = (p1.id + p2.id).split('').reduce((s, c) => s + c.charCodeAt(0), 0) % 2;
  const bgUrl = bgIdx === 0
    ? '/assets/oathbreaker/bg-temple.jpg'
    : '/assets/oathbreaker/bg-waterfall.jpg';

  // Filter chat to these two players
  const battleChat = chatMessages.filter(m => m.from === p1.id || m.from === p2.id);

  useEffect(() => {
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [battleChat.length]);

  return (
    <div className={`arcade-screen ${reveal.flashClass}`} style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* HUD */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '8px 16px', background: 'rgba(0,0,0,0.8)', zIndex: 10,
        borderBottom: '2px solid #333',
      }}>
        <button onClick={onBack} className="pixel-text" style={{
          background: 'transparent', border: '1px solid #444', padding: '4px 10px',
          color: '#9ca3af', fontSize: 7, cursor: 'pointer',
        }}>
          ← BACK
        </button>
        <div style={{ textAlign: 'center' }}>
          <div className="pixel-text" style={{ fontSize: 10, color: '#e9d852', letterSpacing: 3 }}>
            OATHBREAKER
          </div>
          <img src="/assets/oathbreaker/kanji-title-pixel.png" alt="誓約破り" style={{ height: 28, imageRendering: 'pixelated', display: 'block', margin: '2px auto 0' }} />
          <div className="pixel-text" style={{ fontSize: 6, color: '#d1d5db', marginTop: 2, letterSpacing: 2 }}>Seiyaku-yaburi</div>
        </div>
        <span className="pixel-text" style={{ fontSize: 7, color: '#e5e7eb' }}>
          ROUND {currentRound}/{maxRounds}
        </span>
      </div>

      {/* Fighter stats bar */}
      <div style={{
        display: 'flex', gap: 16, padding: '8px 16px',
        background: 'rgba(0,0,0,0.7)', zIndex: 10,
      }}>
        {/* P1 stats */}
        <div style={{ flex: 1 }}>
          <div className="pixel-text" style={{ fontSize: 8, color: '#60a5fa', marginBottom: 4 }}>{name1}</div>
          <HealthBar dollarValue={p1.dollarValue} breakEvenDelta={p1.breakEvenDelta} />
          <div className="pixel-text" style={{ fontSize: 6, color: '#6b7280', marginTop: 2 }}>
            OATHS {p1.oathsKept}/{p1.oathsKept + p1.oathsBroken}
          </div>
        </div>

        {/* VS */}
        <div style={{ display: 'flex', alignItems: 'center', flexShrink: 0, padding: '0 8px' }}>
          <PhaseBadge pairing={pairing} />
        </div>

        {/* P2 stats */}
        <div style={{ flex: 1, textAlign: 'right' }}>
          <div className="pixel-text" style={{ fontSize: 8, color: '#f87171', marginBottom: 4 }}>{name2}</div>
          <HealthBar dollarValue={p2.dollarValue} breakEvenDelta={p2.breakEvenDelta} />
          <div className="pixel-text" style={{ fontSize: 6, color: '#6b7280', marginTop: 2 }}>
            OATHS {p2.oathsKept}/{p2.oathsKept + p2.oathsBroken}
          </div>
        </div>
      </div>

      {/* Arena */}
      <div className={`arena-bg ${reveal.shakeClass}`} style={{
        flex: 1,
        backgroundImage: `url(${bgUrl})`,
        display: 'flex', flexDirection: 'column',
        position: 'relative',
        minHeight: 200,
      }}>
        {/* Darken overlay during reveal */}
        {reveal.phase === 'darken' && (
          <div style={{
            position: 'absolute', inset: 0,
            background: 'rgba(0,0,0,0.6)',
            zIndex: 5,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <span className="pixel-text oath-glow" style={{ fontSize: 10, color: '#eab308', letterSpacing: 3 }}>
              FATES SEALED...
            </span>
          </div>
        )}

        {/* Dollar deltas */}
        {reveal.showDelta && latestResult && (
          <>
            <DollarDelta delta={latestResult.delta1} side="left" />
            <DollarDelta delta={latestResult.delta2} side="right" />
          </>
        )}

        {/* Outcome banner */}
        {(reveal.phase === 'reveal' || reveal.phase === 'aftermath') && latestResult && (
          <div style={{ position: 'absolute', top: '15%', left: 0, right: 0, zIndex: 10 }}>
            <OutcomeBanner outcome={latestResult.outcome} />
          </div>
        )}

        {/* Fighters */}
        <div style={{
          flex: 1,
          display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
          gap: '15%',
          paddingBottom: 16,
          position: 'relative', zIndex: 2,
        }}>
          {/* P1 — left side, faces right (toward center) */}
          <div className={reveal.phase === 'reveal' && reveal.p1Pose === 'victory' ? 'golden-glow' : ''}>
            <CharacterSprite
              character={char1?.characterName ?? 'buchu'}
              pose={reveal.p1Pose}
              faceRight={true}
              scale={4}
              tint={char1?.tint}
            />
          </div>

          {/* P2 — right side, faces left (toward center) */}
          <div className={reveal.phase === 'reveal' && reveal.p2Pose === 'victory' ? 'golden-glow' : ''}>
            <CharacterSprite
              character={char2?.characterName ?? 'star'}
              pose={reveal.p2Pose}
              faceRight={false}
              scale={4}
              tint={char2?.tint}
            />
          </div>
        </div>
      </div>

      {/* Chat / Negotiation panel */}
      <div style={{
        background: 'rgba(0,0,0,0.85)',
        borderTop: '2px solid #333',
        maxHeight: 200,
        overflow: 'hidden',
        display: 'flex', flexDirection: 'column',
      }}>
        {/* Pledge status */}
        {pairing.agreedPledge !== null ? (
          <OathBanner text={`⚔ OATH SWORN — ${pairing.agreedPledge} POINTS ⚔`} glow />
        ) : pairing.phase === 'pledging' ? (
          <div style={{ display: 'flex', padding: '6px 16px', gap: 16, fontSize: 7 }}>
            <span className="pixel-text" style={{ color: '#60a5fa' }}>
              {name1}: {pairing.proposal1 !== null ? `${pairing.proposal1} pts` : '...'}
            </span>
            <span className="pixel-text" style={{ color: '#f87171' }}>
              {name2}: {pairing.proposal2 !== null ? `${pairing.proposal2} pts` : '...'}
            </span>
          </div>
        ) : null}

        {/* Decision indicators */}
        {pairing.phase === 'deciding' || pairing.phase === 'decided' ? (
          <div style={{ display: 'flex', justifyContent: 'center', gap: 24, padding: '4px 16px' }}>
            <span className="pixel-text" style={{
              fontSize: 7,
              color: pairing.player1HasDecided ? '#4ade80' : '#4b5563',
            }}>
              {name1}: {pairing.player1HasDecided ? '🔒 SEALED' : '⏳ DECIDING'}
            </span>
            <span className="pixel-text" style={{
              fontSize: 7,
              color: pairing.player2HasDecided ? '#4ade80' : '#4b5563',
            }}>
              {name2}: {pairing.player2HasDecided ? '🔒 SEALED' : '⏳ DECIDING'}
            </span>
          </div>
        ) : null}

        {/* Chat messages */}
        <div ref={chatRef} style={{
          flex: 1, overflowY: 'auto', padding: '4px 16px',
          maxHeight: 120,
        }}>
          {battleChat.map((msg, i) => {
            const isP1 = msg.from === p1.id;
            const senderName = isP1 ? name1 : name2;
            const color = isP1 ? '#60a5fa' : '#f87171';
            return (
              <div key={i} style={{ marginBottom: 2, fontSize: 11, lineHeight: 1.4 }}>
                <span style={{ color, fontWeight: 'bold' }}>{senderName}:</span>{' '}
                <span style={{ color: '#d1d5db' }}>{msg.message}</span>
              </div>
            );
          })}
          {battleChat.length === 0 && (
            <div style={{ color: '#4b5563', fontSize: 10, fontStyle: 'italic', padding: 4 }}>
              Awaiting negotiation...
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
