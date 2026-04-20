import { useEffect, useRef, useState } from 'react';
import type { CharacterAssignment } from '../utils/characterAssignment';
import type { Pose } from '../utils/spriteMap';
import { CharacterSprite } from './CharacterSprite';
import { HealthBar } from './HealthBar';

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
// Phases: none → darken(800ms) → windup(400ms) → action(600ms) → impact(400ms) → aftermath(1500ms) → none
// Total: ~3.7s per round

type RevealPhase = 'none' | 'darken' | 'windup' | 'action' | 'impact' | 'aftermath';

interface RevealState {
  phase: RevealPhase;
  p1Pose: Pose;
  p2Pose: Pose;
  shakeClass: string;
  flashClass: string;
  showDelta: boolean;
  /** CSS class for outcome-specific effects (golden-ripple, spark-burst, red-slash) */
  effectClass: string;
  /** Outcome banner text + color, shown during action/impact/aftermath */
  banner: { text: string; color: string } | null;
  /** Whether fighters should lunge toward center */
  lunge: 'none' | 'both' | 'p1' | 'p2';
}

const TIMING = { darken: 800, windup: 400, action: 600, impact: 400, aftermath: 1500 };

function useRevealAnimation(
  result: OathPairingResult | undefined,
  animate: boolean,
  newRoundResults: OathPairingResult[] | null,
): RevealState {
  // biome-ignore lint/correctness/useHookAtTopLevel: conditional hook pattern; refactor in cleanup followup — TODO(2.3-followup)
  const [phase, setPhase] = useState<RevealPhase>('none');
  // biome-ignore lint/correctness/useHookAtTopLevel: conditional hook pattern; refactor in cleanup followup — TODO(2.3-followup)
  const lastResultRef = useRef<string>('');

  const resultKey = result
    ? `${result.player1}-${result.player2}-${result.move1}-${result.move2}-${result.pledge}`
    : '';

  const hasNewRound = newRoundResults != null && newRoundResults.length > 0;

  // biome-ignore lint/correctness/useHookAtTopLevel: conditional hook pattern; refactor in cleanup followup — TODO(2.3-followup)
  useEffect(() => {
    if (!result) return;

    if (!animate) {
      lastResultRef.current = resultKey;
      setPhase('none');
      return;
    }

    if (resultKey === lastResultRef.current && !hasNewRound) return;
    lastResultRef.current = resultKey;

    // Sequenced animation
    setPhase('darken');
    let t = TIMING.darken;
    const t1 = setTimeout(() => setPhase('windup'), t);
    t += TIMING.windup;
    const t2 = setTimeout(() => setPhase('action'), t);
    t += TIMING.action;
    const t3 = setTimeout(() => setPhase('impact'), t);
    t += TIMING.impact;
    const t4 = setTimeout(() => setPhase('aftermath'), t);
    t += TIMING.aftermath;
    const t5 = setTimeout(() => setPhase('none'), t);

    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
      clearTimeout(t4);
      clearTimeout(t5);
    };
  }, [resultKey, result, animate, hasNewRound]);

  const noState: RevealState = {
    phase: 'none',
    p1Pose: 'idle',
    p2Pose: 'idle',
    shakeClass: '',
    flashClass: '',
    showDelta: false,
    effectClass: '',
    banner: null,
    lunge: 'none',
  };

  if (!result || phase === 'none') {
    if (!animate && result) {
      return getFinalState(result.outcome);
    }
    return noState;
  }

  return getPhaseState(phase, result.outcome);
}

/** Final resting state when not animating (replay scrub). */
function getFinalState(outcome: string): RevealState {
  const base: RevealState = {
    phase: 'none',
    shakeClass: '',
    flashClass: '',
    showDelta: true,
    effectClass: '',
    banner: null,
    lunge: 'none',
    p1Pose: 'idle',
    p2Pose: 'idle',
  };
  if (outcome === 'cooperation') {
    return { ...base, p1Pose: 'victory', p2Pose: 'victory' };
  } else if (outcome === 'betrayal_1') {
    return { ...base, p1Pose: 'attack', p2Pose: 'hit' };
  } else if (outcome === 'betrayal_2') {
    return { ...base, p1Pose: 'hit', p2Pose: 'attack' };
  } else if (outcome === 'standoff') {
    return { ...base, p1Pose: 'attack', p2Pose: 'attack' };
  }
  return base;
}

/** Per-phase animation state for each outcome type. */
function getPhaseState(phase: RevealPhase, outcome: string): RevealState {
  const base: RevealState = {
    phase,
    shakeClass: '',
    flashClass: '',
    showDelta: false,
    effectClass: '',
    banner: null,
    lunge: 'none',
    p1Pose: 'idle',
    p2Pose: 'idle',
  };

  if (phase === 'darken') {
    return { ...base, p1Pose: 'idle', p2Pose: 'idle' };
  }

  if (outcome === 'cooperation') {
    // Bow → victory → golden ripple
    switch (phase) {
      case 'windup':
        return { ...base, p1Pose: 'idle', p2Pose: 'idle' }; // slight bow (CSS handles dip)
      case 'action':
        return {
          ...base,
          p1Pose: 'victory',
          p2Pose: 'victory',
          effectClass: 'golden-ripple',
          banner: { text: 'HONOR', color: '#fbbf24' },
        };
      case 'impact':
        return { ...base, p1Pose: 'victory', p2Pose: 'victory', effectClass: 'golden-ripple' };
      case 'aftermath':
        return {
          ...base,
          p1Pose: 'victory',
          p2Pose: 'victory',
          showDelta: true,
          banner: { text: 'OATH HONORED', color: '#4ade80' },
        };
    }
  } else if (outcome === 'betrayal_1') {
    // P1 attacks, P2 gets hit
    switch (phase) {
      case 'windup':
        return { ...base, p1Pose: 'attack', p2Pose: 'idle', lunge: 'p1' };
      case 'action':
        return {
          ...base,
          p1Pose: 'attack',
          p2Pose: 'hit',
          shakeClass: 'shake',
          flashClass: 'red-flash',
          effectClass: 'red-slash-right',
          banner: { text: 'BETRAYED!', color: '#f87171' },
        };
      case 'impact':
        return { ...base, p1Pose: 'attack', p2Pose: 'hit', effectClass: 'red-slash-right' };
      case 'aftermath':
        return {
          ...base,
          p1Pose: 'attack',
          p2Pose: 'hit',
          showDelta: true,
          banner: { text: 'OATH BROKEN', color: '#f87171' },
        };
    }
  } else if (outcome === 'betrayal_2') {
    // P2 attacks, P1 gets hit
    switch (phase) {
      case 'windup':
        return { ...base, p1Pose: 'idle', p2Pose: 'attack', lunge: 'p2' };
      case 'action':
        return {
          ...base,
          p1Pose: 'hit',
          p2Pose: 'attack',
          shakeClass: 'shake',
          flashClass: 'red-flash',
          effectClass: 'red-slash-left',
          banner: { text: 'BETRAYED!', color: '#f87171' },
        };
      case 'impact':
        return { ...base, p1Pose: 'hit', p2Pose: 'attack', effectClass: 'red-slash-left' };
      case 'aftermath':
        return {
          ...base,
          p1Pose: 'hit',
          p2Pose: 'attack',
          showDelta: true,
          banner: { text: 'OATH BROKEN', color: '#f87171' },
        };
    }
  } else if (outcome === 'standoff') {
    // Both lunge + clash
    switch (phase) {
      case 'windup':
        return { ...base, p1Pose: 'attack', p2Pose: 'attack', lunge: 'both' };
      case 'action':
        return {
          ...base,
          p1Pose: 'attack',
          p2Pose: 'attack',
          shakeClass: 'shake',
          flashClass: 'red-flash',
          effectClass: 'spark-burst',
          banner: { text: 'CLASH!', color: '#fb923c' },
        };
      case 'impact':
        return { ...base, p1Pose: 'hit', p2Pose: 'hit', shakeClass: 'shake' };
      case 'aftermath':
        return {
          ...base,
          p1Pose: 'attack',
          p2Pose: 'attack',
          showDelta: true,
          banner: { text: 'BOTH FORSWORN', color: '#fbbf24' },
        };
    }
  }

  return base;
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
    <span
      className="pixel-text"
      style={{
        fontSize: 7,
        letterSpacing: 2,
        padding: '4px 10px',
        // @ts-expect-error TS18048: 's' is possibly 'undefined'. — TODO(2.3-followup)
        background: s.bg,
        // @ts-expect-error TS18048: 's' is possibly 'undefined'. — TODO(2.3-followup)
        color: s.color,
        // @ts-expect-error TS18048: 's' is possibly 'undefined'. — TODO(2.3-followup)
        border: `1px solid ${s.color}33`,
      }}
    >
      {/* @ts-expect-error TS18048: 's' is possibly 'undefined'. — TODO(2.3-followup) */}
      {s.label}
    </span>
  );
}

function OathBanner({ text, glow }: { text: string; glow?: boolean }) {
  return (
    <div
      className={glow ? 'oath-glow' : ''}
      style={{
        textAlign: 'center',
        padding: '8px 16px',
        background: 'rgba(234, 179, 8, 0.1)',
        border: '1px solid rgba(234, 179, 8, 0.3)',
        fontSize: 8,
        fontFamily: "'Press Start 2P', monospace",
        color: '#eab308',
        letterSpacing: 2,
      }}
    >
      {text}
    </div>
  );
}

function DollarDelta({ delta, side }: { delta: number; side: 'left' | 'right' }) {
  const color = delta >= 0 ? '#4ade80' : '#f87171';
  const text = delta >= 0 ? `+$${delta.toFixed(2)}` : `-$${Math.abs(delta).toFixed(2)}`;

  return (
    <div
      className="float-up pixel-text"
      style={{
        position: 'absolute',
        [side]: '20%',
        top: '30%',
        fontSize: 12,
        color,
        fontWeight: 'bold',
        textShadow: `0 0 8px ${color}`,
        zIndex: 10,
      }}
    >
      {text}
    </div>
  );
}

function ChatBubble({
  message,
  side,
  visible,
}: {
  message: string;
  side: 'left' | 'right';
  visible: boolean;
}) {
  if (!message || !visible) return null;
  const truncated = message.length > 60 ? `${message.slice(0, 57)}...` : message;
  const isLeft = side === 'left';

  return (
    <div
      className={`chat-bubble chat-bubble-${side}`}
      style={{
        position: 'absolute',
        [isLeft ? 'left' : 'right']: '5%',
        top: '5%',
        maxWidth: '40%',
        background: 'rgba(255,255,255,0.95)',
        color: '#111',
        padding: '6px 10px',
        fontSize: 9,
        fontFamily: "'Press Start 2P', monospace",
        lineHeight: 1.5,
        borderRadius: 4,
        zIndex: 8,
        opacity: visible ? 1 : 0,
        transition: 'opacity 0.3s',
        wordBreak: 'break-word',
      }}
    >
      {truncated}
      {/* Speech bubble tail */}
      <div
        style={{
          position: 'absolute',
          bottom: -8,
          [isLeft ? 'left' : 'right']: 16,
          width: 0,
          height: 0,
          borderLeft: '6px solid transparent',
          borderRight: '6px solid transparent',
          borderTop: '8px solid rgba(255,255,255,0.95)',
        }}
      />
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
  /** Player being followed across rounds — shown in the HUD. */
  followedPlayerId?: string | null;
  onBack: () => void;
  /** Whether to animate transitions. False during replay scrubbing. */
  animate?: boolean;
  /** New round results from a replay transition (null if no new round). */
  newRoundResults?: OathPairingResult[] | null;
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
  followedPlayerId,
  onBack,
  animate = true,
  newRoundResults = null,
}: ArcadeBattleViewProps) {
  const chatRef = useRef<HTMLDivElement>(null);
  const p1 = players.find((p) => p.id === pairing.player1);
  const p2 = players.find((p) => p.id === pairing.player2);
  if (!p1 || !p2) return null;

  const name1 = handles[p1.id] ?? p1.id.slice(0, 8);
  const name2 = handles[p2.id] ?? p2.id.slice(0, 8);
  const char1 = characters[p1.id];
  const char2 = characters[p2.id];

  // Find the followed player's most recent result.
  // Pairings rotate each round — after a round resolves, the snapshot already
  // has the NEXT round's pairings, so the current p1/p2 pairing won't match
  // the just-resolved results. Instead, search for any result involving the
  // followed player (p1, since SpectatorView normalizes pairing order).
  let latestResult: OathPairingResult | undefined;
  for (let i = roundResults.length - 1; i >= 0; i--) {
    const match = roundResults[i]?.find((r) => r.player1 === p1.id || r.player2 === p1.id);
    if (match) {
      latestResult = match;
      break;
    }
  }

  // biome-ignore lint/correctness/useHookAtTopLevel: conditional hook pattern; refactor in cleanup followup — TODO(2.3-followup)
  const reveal = useRevealAnimation(latestResult, animate, newRoundResults);

  // Determine background
  const bgIdx = (p1.id + p2.id).split('').reduce((s, c) => s + c.charCodeAt(0), 0) % 2;
  const bgUrl =
    bgIdx === 0 ? '/assets/oathbreaker/bg-temple.jpg' : '/assets/oathbreaker/bg-waterfall.jpg';

  // Filter chat to these two players
  const battleChat = chatMessages.filter((m) => m.from === p1.id || m.from === p2.id);

  // Latest chat message per player (for speech bubbles)
  const p1LastMsg = [...battleChat].reverse().find((m) => m.from === p1.id)?.message ?? '';
  const p2LastMsg = [...battleChat].reverse().find((m) => m.from === p2.id)?.message ?? '';
  const showBubbles = reveal.phase === 'darken' || reveal.phase === 'none';

  // biome-ignore lint/correctness/useHookAtTopLevel: conditional hook pattern; refactor in cleanup followup — TODO(2.3-followup)
  useEffect(() => {
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, []);

  // Chat panel (reused in both layouts)
  const chatPanel = (
    <div
      style={{
        flex: 1,
        background: 'rgba(0,0,0,0.85)',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        overflow: 'hidden',
      }}
    >
      {/* Pledge status */}
      <div style={{ flexShrink: 0 }}>
        {pairing.agreedPledge !== null ? (
          <OathBanner text={`⚔ OATH SWORN — ${pairing.agreedPledge} PTS ⚔`} glow />
        ) : pairing.phase === 'pledging' ? (
          <div
            style={{ display: 'flex', padding: '6px 12px', gap: 12, fontSize: 7, flexWrap: 'wrap' }}
          >
            <span className="pixel-text" style={{ color: '#60a5fa' }}>
              {name1}: {pairing.proposal1 !== null ? `${pairing.proposal1} pts` : '...'}
            </span>
            <span className="pixel-text" style={{ color: '#f87171' }}>
              {name2}: {pairing.proposal2 !== null ? `${pairing.proposal2} pts` : '...'}
            </span>
          </div>
        ) : null}

        {(pairing.phase === 'deciding' || pairing.phase === 'decided') && (
          <div
            style={{
              display: 'flex',
              justifyContent: 'center',
              gap: 16,
              padding: '4px 12px',
              flexWrap: 'wrap',
            }}
          >
            <span
              className="pixel-text"
              style={{
                fontSize: 7,
                color: pairing.player1HasDecided ? '#4ade80' : '#9ca3af',
              }}
            >
              {name1}: {pairing.player1HasDecided ? 'SEALED' : 'DECIDING...'}
            </span>
            <span
              className="pixel-text"
              style={{
                fontSize: 7,
                color: pairing.player2HasDecided ? '#4ade80' : '#9ca3af',
              }}
            >
              {name2}: {pairing.player2HasDecided ? 'SEALED' : 'DECIDING...'}
            </span>
          </div>
        )}
      </div>

      {/* Chat header */}
      <div
        className="pixel-text"
        style={{
          fontSize: 7,
          color: '#6b7280',
          padding: '6px 12px 2px',
          letterSpacing: 1.5,
          flexShrink: 0,
        }}
      >
        NEGOTIATION
      </div>

      {/* Chat messages */}
      <div ref={chatRef} style={{ flex: 1, overflowY: 'auto', padding: '4px 12px', minHeight: 0 }}>
        {battleChat.map((msg, i) => {
          const isP1 = msg.from === p1.id;
          const senderName = isP1 ? name1 : name2;
          const color = isP1 ? '#60a5fa' : '#f87171';
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: list is stable; refactor in cleanup followup — TODO(2.3-followup)
            <div key={i} style={{ marginBottom: 3, fontSize: 12, lineHeight: 1.4 }}>
              <span style={{ color, fontWeight: 'bold' }}>{senderName}:</span>{' '}
              <span style={{ color: '#d1d5db' }}>{msg.message}</span>
            </div>
          );
        })}
        {battleChat.length === 0 && (
          <div style={{ color: '#6b7280', fontSize: 11, fontStyle: 'italic', padding: '8px 0' }}>
            Awaiting negotiation...
          </div>
        )}
      </div>
    </div>
  );

  // Lunge transform for fighters (slide toward center during attack)
  const p1Lunge = reveal.lunge === 'both' || reveal.lunge === 'p1' ? 'translateX(30px)' : '';
  const p2Lunge = reveal.lunge === 'both' || reveal.lunge === 'p2' ? 'translateX(-30px)' : '';

  // Arena panel (reused in both layouts)
  const arenaPanel = (
    <div
      className={`arena-bg ${reveal.shakeClass}`}
      style={{
        backgroundImage: `url(${bgUrl})`,
        display: 'flex',
        flexDirection: 'column',
        position: 'relative',
        minHeight: 250,
      }}
    >
      {reveal.phase === 'darken' && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background: 'rgba(0,0,0,0.6)',
            zIndex: 5,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <span
            className="pixel-text oath-glow"
            style={{ fontSize: 10, color: '#eab308', letterSpacing: 3 }}
          >
            FATES SEALED...
          </span>
        </div>
      )}

      {/* Chat bubbles over fighters */}
      <ChatBubble message={p1LastMsg} side="left" visible={showBubbles && !!p1LastMsg} />
      <ChatBubble message={p2LastMsg} side="right" visible={showBubbles && !!p2LastMsg} />

      {reveal.showDelta && latestResult && (
        <>
          <DollarDelta delta={latestResult.delta1} side="left" />
          <DollarDelta delta={latestResult.delta2} side="right" />
        </>
      )}

      {/* Outcome-specific effect overlays */}
      {reveal.effectClass && (
        <div
          className={reveal.effectClass}
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 6,
            pointerEvents: 'none',
          }}
        />
      )}

      {/* Outcome banner (from reveal state) */}
      {reveal.banner && (
        <div
          className="fade-in-up"
          style={{ position: 'absolute', top: '10%', left: 0, right: 0, zIndex: 10 }}
        >
          <div
            className="pixel-text"
            style={{
              textAlign: 'center',
              fontSize: 14,
              color: reveal.banner.color,
              textShadow: `0 0 12px ${reveal.banner.color}`,
              letterSpacing: 3,
              padding: '12px 0',
            }}
          >
            {reveal.banner.text}
          </div>
        </div>
      )}

      {/* Fighters — fill the arena */}
      <div
        className="arena-fighters"
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'center',
          paddingBottom: 8,
          position: 'relative',
          zIndex: 2,
        }}
      >
        <div
          className={reveal.p1Pose === 'victory' && reveal.phase !== 'none' ? 'golden-glow' : ''}
          style={{ transform: p1Lunge, transition: 'transform 0.3s ease-out' }}
        >
          {/* @ts-expect-error TS2375: Type '{ character: string; pose: Pose; faceRight: true; scale: number; tint: str — TODO(2.3-followup) */}
          <CharacterSprite
            character={char1?.characterName ?? 'buchu'}
            pose={reveal.p1Pose}
            faceRight={true}
            scale={5}
            tint={char1?.tint}
            animated
          />
        </div>
        <div
          className={reveal.p2Pose === 'victory' && reveal.phase !== 'none' ? 'golden-glow' : ''}
          style={{ transform: p2Lunge, transition: 'transform 0.3s ease-out' }}
        >
          {/* @ts-expect-error TS2375: Type '{ character: string; pose: Pose; faceRight: false; scale: number; tint: st — TODO(2.3-followup) */}
          <CharacterSprite
            character={char2?.characterName ?? 'star'}
            pose={reveal.p2Pose}
            faceRight={false}
            scale={5}
            tint={char2?.tint}
            animated
          />
        </div>
      </div>
    </div>
  );

  return (
    <div
      className={`arcade-screen ${reveal.flashClass}`}
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
      }}
    >
      {/* HUD — full width, always on top */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '8px 16px',
          background: 'rgba(0,0,0,0.8)',
          zIndex: 10,
          borderBottom: '2px solid #333',
          flexShrink: 0,
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          {/* biome-ignore lint/a11y/useButtonType: pre-existing button without type; cleanup followup — TODO(2.3-followup) */}
          <button
            onClick={onBack}
            className="pixel-text"
            style={{
              background: 'transparent',
              border: '1px solid #444',
              padding: '4px 10px',
              color: '#9ca3af',
              fontSize: 7,
              cursor: 'pointer',
            }}
          >
            ← BACK
          </button>
          {followedPlayerId && (
            <span
              className="pixel-text"
              style={{
                fontSize: 6,
                color: '#e9d852',
                letterSpacing: 1.5,
                padding: '2px 4px',
              }}
            >
              ▶ FOLLOWING {handles[followedPlayerId] ?? followedPlayerId.slice(0, 8)}
            </span>
          )}
        </div>
        <div style={{ textAlign: 'center' }}>
          <div className="pixel-text" style={{ fontSize: 10, color: '#e9d852', letterSpacing: 3 }}>
            OATHBREAKER
          </div>
          <img
            src="/assets/oathbreaker/kanji-title-pixel.png"
            alt="誓約破り"
            style={{
              height: 24,
              imageRendering: 'pixelated',
              display: 'block',
              margin: '2px auto 0',
            }}
          />
        </div>
        <span className="pixel-text" style={{ fontSize: 7, color: '#e5e7eb' }}>
          ROUND {currentRound}/{maxRounds}
        </span>
      </div>

      {/* Fighter stats — full width */}
      <div
        style={{
          display: 'flex',
          gap: 16,
          padding: '8px 16px',
          background: 'rgba(0,0,0,0.7)',
          zIndex: 10,
          flexShrink: 0,
        }}
      >
        <div style={{ flex: 1 }}>
          <div className="pixel-text" style={{ fontSize: 8, color: '#60a5fa', marginBottom: 4 }}>
            {name1}
          </div>
          <HealthBar dollarValue={p1.dollarValue} breakEvenDelta={p1.breakEvenDelta} />
          <div className="pixel-text" style={{ fontSize: 6, color: '#9ca3af', marginTop: 2 }}>
            OATHS {p1.oathsKept}/{p1.oathsKept + p1.oathsBroken}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', flexShrink: 0, padding: '0 8px' }}>
          <PhaseBadge pairing={pairing} />
        </div>
        <div style={{ flex: 1, textAlign: 'right' }}>
          <div className="pixel-text" style={{ fontSize: 8, color: '#f87171', marginBottom: 4 }}>
            {name2}
          </div>
          <HealthBar dollarValue={p2.dollarValue} breakEvenDelta={p2.breakEvenDelta} />
          <div className="pixel-text" style={{ fontSize: 6, color: '#9ca3af', marginTop: 2 }}>
            OATHS {p2.oathsKept}/{p2.oathsKept + p2.oathsBroken}
          </div>
        </div>
      </div>

      {/* Main content: side-by-side on desktop (>640px), stacked on mobile */}
      <div
        className="battle-content"
        style={{
          flex: 1,
          display: 'flex',
          minHeight: 0,
          overflow: 'hidden',
        }}
      >
        {/* Arena */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          {arenaPanel}
        </div>
        {/* Chat — beside arena on desktop, below on mobile */}
        <div
          className="battle-chat"
          style={{
            display: 'flex',
            flexDirection: 'column',
            minHeight: 0,
            borderLeft: '2px solid #333',
          }}
        >
          {chatPanel}
        </div>
      </div>
    </div>
  );
}
