import { useMemo } from 'react';
import type { CharacterAssignment } from '../utils/characterAssignment';
import { CharacterSprite } from './CharacterSprite';

// ---- Types (mirrored from SpectatorView.tsx so the component stays
// self-contained — no import from the games package in the web bundle) ----

interface OathPlayer {
  id: string;
  creditValue: number;
  breakEvenDelta: number;
  cooperationRate: number;
  oathsKept: number;
  oathsBroken: number;
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

interface GameOverScreenProps {
  players: OathPlayer[];
  roundResults: OathPairingResult[][];
  handles: Record<string, string>;
  characters: Record<string, CharacterAssignment>;
  gameId: string;
}

// ---- Seeded RNG ---------------------------------------------------------
// A deterministic PRNG keyed off the gameId so tiebreaker picks stay stable
// across re-renders (React effects would otherwise reshuffle on every paint).

function hash32(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sampleN<T>(arr: T[], n: number, rng: () => number): T[] {
  if (arr.length <= n) return [...arr];
  const picked = new Set<number>();
  while (picked.size < n) picked.add(Math.floor(rng() * arr.length));
  return [...picked].map((i) => arr[i] as T);
}

function pickOne<T>(arr: T[], rng: () => number): T | null {
  if (arr.length === 0) return null;
  return arr[Math.floor(rng() * arr.length)] ?? null;
}

// ---- Computation --------------------------------------------------------

const MAX_WINNERS_SHOWN = 5;

interface WinnerComputation {
  winners: OathPlayer[];
  topValue: number;
  wasTruncated: boolean;
}

function computeWinners(players: OathPlayer[], rng: () => number): WinnerComputation {
  if (players.length === 0) return { winners: [], topValue: 0, wasTruncated: false };
  const topValue = players.reduce(
    (max, p) => (p.creditValue > max ? p.creditValue : max),
    Number.NEGATIVE_INFINITY,
  );
  const tied = players.filter((p) => p.creditValue === topValue);
  const wasTruncated = tied.length > MAX_WINNERS_SHOWN;
  return { winners: sampleN(tied, MAX_WINNERS_SHOWN, rng), topValue, wasTruncated };
}

interface OathbreakerCandidate {
  playerId: string;
  payoff: number;
  round: number;
  pledge: number;
  victimId: string;
}

function computeOathbreaker(
  roundResults: OathPairingResult[][],
  rng: () => number,
): OathbreakerCandidate | null {
  // "Biggest one-time betrayer": the single largest payoff delta collected
  // in one pairing by defecting while the opponent cooperated. Random pick
  // among ties on payoff amount.
  let topPayoff = Number.NEGATIVE_INFINITY;
  let candidates: OathbreakerCandidate[] = [];
  for (let r = 0; r < roundResults.length; r++) {
    const pairings = roundResults[r] ?? [];
    for (const pair of pairings) {
      let candidate: OathbreakerCandidate | null = null;
      if (pair.outcome === 'betrayal_1') {
        candidate = {
          playerId: pair.player1,
          payoff: pair.delta1,
          round: r + 1,
          pledge: pair.pledge,
          victimId: pair.player2,
        };
      } else if (pair.outcome === 'betrayal_2') {
        candidate = {
          playerId: pair.player2,
          payoff: pair.delta2,
          round: r + 1,
          pledge: pair.pledge,
          victimId: pair.player1,
        };
      }
      if (!candidate) continue;
      if (candidate.payoff > topPayoff) {
        topPayoff = candidate.payoff;
        candidates = [candidate];
      } else if (candidate.payoff === topPayoff) {
        candidates.push(candidate);
      }
    }
  }
  return pickOne(candidates, rng);
}

// ---- Component ----------------------------------------------------------

export function GameOverScreen({
  players,
  roundResults,
  handles,
  characters,
  gameId,
}: GameOverScreenProps) {
  const { winners, oathbreaker, wasTruncated } = useMemo(() => {
    const rng = mulberry32(hash32(gameId));
    const winnersResult = computeWinners(players, rng);
    const oathbreakerResult = computeOathbreaker(roundResults, rng);
    return {
      winners: winnersResult.winners,
      wasTruncated: winnersResult.wasTruncated,
      oathbreaker: oathbreakerResult,
    };
  }, [players, roundResults, gameId]);

  const nameOf = (id: string): string => handles[id] ?? id.slice(0, 8);

  return (
    <div
      className="arcade-screen"
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        padding: 24,
        overflowY: 'auto',
      }}
    >
      <div
        style={{
          textAlign: 'center',
          padding: '8px 0 20px',
          borderBottom: '2px solid #1f2937',
          marginBottom: 24,
        }}
      >
        <div
          className="pixel-text"
          style={{
            fontSize: 18,
            color: '#e9d852',
            letterSpacing: 8,
            textShadow: '0 0 16px rgba(233, 216, 82, 0.6)',
          }}
        >
          GAME OVER
        </div>
        <div
          className="pixel-text"
          style={{ fontSize: 8, color: '#d1d5db', marginTop: 8, letterSpacing: 3 }}
        >
          TOURNAMENT COMPLETE
        </div>
      </div>

      <section style={{ marginBottom: 32 }}>
        <div
          className="pixel-text"
          style={{
            fontSize: 10,
            color: '#4ade80',
            letterSpacing: 4,
            textAlign: 'center',
            marginBottom: 16,
          }}
        >
          {winners.length === 1 ? 'WINNER' : `WINNERS (${winners.length})`}
        </div>
        <div
          style={{
            display: 'flex',
            justifyContent: 'center',
            flexWrap: 'wrap',
            gap: 16,
          }}
        >
          {winners.map((p) => {
            const char = characters[p.id];
            return (
              <div
                key={p.id}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  padding: 12,
                  background: 'rgba(74, 222, 128, 0.08)',
                  border: '1px solid rgba(74, 222, 128, 0.4)',
                  minWidth: 110,
                }}
              >
                <div
                  style={{
                    width: 64,
                    height: 80,
                    display: 'flex',
                    alignItems: 'flex-end',
                    justifyContent: 'center',
                    background: '#0a0a0f',
                    marginBottom: 8,
                    overflow: 'hidden',
                  }}
                >
                  {/* @ts-expect-error CharacterSprite props are overly strict; tint is optional at runtime. */}
                  <CharacterSprite
                    character={char?.characterName ?? 'buchu'}
                    pose="idle"
                    scale={2}
                    tint={char?.tint}
                  />
                </div>
                <div
                  className="pixel-text"
                  style={{ fontSize: 8, color: '#e5e7eb', textAlign: 'center' }}
                >
                  {nameOf(p.id)}
                </div>
                <div className="pixel-text" style={{ fontSize: 7, color: '#4ade80', marginTop: 4 }}>
                  {p.creditValue.toFixed(2)} cr
                </div>
              </div>
            );
          })}
        </div>
        {wasTruncated ? (
          <div
            className="pixel-text"
            style={{
              fontSize: 7,
              color: '#9ca3af',
              textAlign: 'center',
              marginTop: 10,
              letterSpacing: 2,
            }}
          >
            (TIED FOR 1ST — SHOWING 5 RANDOM)
          </div>
        ) : null}
      </section>

      {oathbreaker ? (
        <section>
          <div
            className="pixel-text"
            style={{
              fontSize: 10,
              color: '#f87171',
              letterSpacing: 4,
              textAlign: 'center',
              marginBottom: 16,
            }}
          >
            OATHBREAKER
          </div>
          <div style={{ display: 'flex', justifyContent: 'center' }}>
            {(() => {
              const char = characters[oathbreaker.playerId];
              return (
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    padding: 16,
                    background: 'rgba(248, 113, 113, 0.08)',
                    border: '1px solid rgba(248, 113, 113, 0.5)',
                    minWidth: 140,
                  }}
                >
                  <div
                    style={{
                      width: 80,
                      height: 96,
                      display: 'flex',
                      alignItems: 'flex-end',
                      justifyContent: 'center',
                      background: '#0a0a0f',
                      marginBottom: 8,
                      overflow: 'hidden',
                    }}
                  >
                    {/* @ts-expect-error CharacterSprite props are overly strict; tint is optional at runtime. */}
                    <CharacterSprite
                      character={char?.characterName ?? 'buchu'}
                      pose="idle"
                      scale={2.5}
                      tint={char?.tint}
                    />
                  </div>
                  <div
                    className="pixel-text"
                    style={{ fontSize: 9, color: '#e5e7eb', textAlign: 'center' }}
                  >
                    {nameOf(oathbreaker.playerId)}
                  </div>
                  <div
                    className="pixel-text"
                    style={{ fontSize: 7, color: '#f87171', marginTop: 6 }}
                  >
                    +{oathbreaker.payoff.toFixed(2)} PTS
                  </div>
                  <div
                    className="pixel-text"
                    style={{ fontSize: 6, color: '#9ca3af', marginTop: 4, textAlign: 'center' }}
                  >
                    ROUND {oathbreaker.round} · BROKE {nameOf(oathbreaker.victimId)}
                  </div>
                </div>
              );
            })()}
          </div>
        </section>
      ) : null}
    </div>
  );
}
