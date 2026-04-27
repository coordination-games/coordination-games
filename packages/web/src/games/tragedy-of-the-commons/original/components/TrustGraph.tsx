import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatAgentName, shortName } from '../lib/format';
import {
  COOPERATION_LABELS,
  computeTypology,
  describeTile,
  peerColumnFor,
  RELIABILITY_LABELS,
  SPECTRUM_SIZE,
  type TypologyResult,
} from '../lib/trustTypology';
import { type TrustCard, useGameStore, type VisibleBehaviorTag } from '../store';

interface TrailEntry {
  round: number;
  row: number;
  col: number;
}

type Rgb = readonly [number, number, number];

const TRAIL_MAX = 6;

const TILE_BASE: Rgb = [18, 31, 43];
const TILE_AMBER: Rgb = [126, 97, 64];
const TILE_RED: Rgb = [176, 79, 82];
const TILE_RED_BRIGHT: Rgb = [204, 97, 97];
const TILE_GREEN: Rgb = [91, 148, 92];
const TILE_GREEN_BRIGHT: Rgb = [126, 189, 110];

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function mixColor(start: Rgb, end: Rgb, amount: number): [number, number, number] {
  const t = clamp01(amount);
  return [
    Math.round(start[0] + (end[0] - start[0]) * t),
    Math.round(start[1] + (end[1] - start[1]) * t),
    Math.round(start[2] + (end[2] - start[2]) * t),
  ];
}

function toRgba([r, g, b]: readonly [number, number, number], alpha: number): string {
  return `rgba(${r}, ${g}, ${b}, ${clamp01(alpha).toFixed(3)})`;
}

function behaviorLabel(tag: VisibleBehaviorTag): string {
  const kind = tag.kind.length > 0 ? tag.kind.replace(/_/g, ' ') : '';
  const description = tag.description.trim();
  const severity = tag.severity.length > 0 ? ` · ${tag.severity}` : '';

  if (kind && description) return `${kind} — ${description}${severity}`;
  if (description) return `${description}${severity}`;
  if (kind) return `${kind}${severity}`;
  return `behavior${severity}`;
}

function tileTone(row: number, col: number): string {
  const coopNorm = row / (SPECTRUM_SIZE - 1); // 0..1
  const relNorm = col / (SPECTRUM_SIZE - 1); // 0..1

  if (coopNorm > 0.55) {
    const t = (coopNorm - 0.55) / 0.45;
    const target = mixColor(TILE_GREEN, TILE_GREEN_BRIGHT, 0.28 + relNorm * 0.42);
    const color = mixColor(TILE_BASE, target, 0.45 + t * 0.34 + relNorm * 0.08);
    return toRgba(color, 0.12 + relNorm * 0.18 + t * 0.1);
  }

  if (coopNorm < 0.45) {
    const t = (0.45 - coopNorm) / 0.45;
    const target = mixColor(TILE_RED, TILE_RED_BRIGHT, 0.24 + (1 - relNorm) * 0.34);
    const warmed = mixColor(target, TILE_AMBER, relNorm * 0.18);
    const color = mixColor(TILE_BASE, warmed, 0.42 + t * 0.4 + (1 - relNorm) * 0.06);
    return toRgba(color, 0.12 + relNorm * 0.16 + t * 0.11);
  }

  const centerColor = mixColor(TILE_BASE, TILE_AMBER, 0.46 + relNorm * 0.24);
  return toRgba(centerColor, 0.13 + relNorm * 0.14);
}

function tileBorder(row: number, col: number): string {
  const coopNorm = row / (SPECTRUM_SIZE - 1);
  const relNorm = col / (SPECTRUM_SIZE - 1);

  if (coopNorm > 0.6) {
    const t = (coopNorm - 0.6) / 0.4;
    return toRgba(
      mixColor(TILE_GREEN, TILE_GREEN_BRIGHT, t * 0.75 + relNorm * 0.2),
      0.26 + relNorm * 0.14 + t * 0.08,
    );
  }

  if (coopNorm < 0.4) {
    const t = (0.4 - coopNorm) / 0.4;
    return toRgba(
      mixColor(TILE_RED, TILE_RED_BRIGHT, t * 0.8 + (1 - relNorm) * 0.12),
      0.24 + (1 - relNorm) * 0.08 + t * 0.1,
    );
  }

  return toRgba([208, 184, 142], 0.14 + relNorm * 0.06);
}

function useAgentTrail(agentId: string | null, round: number, row: number, col: number) {
  const [trails, setTrails] = useState<Record<string, TrailEntry[]>>({});
  const pendingRef = useRef<{ agentId: string; round: number; row: number; col: number } | null>(
    null,
  );
  const lastKeyRef = useRef<Record<string, string>>({});

  // Flush callback runs outside the effect body via requestAnimationFrame,
  // avoiding the setState-in-effect lint violation.
  const flush = useCallback(() => {
    const {
      agentId: id,
      round: rnd,
      row: r,
      col: c,
    } = pendingRef.current ?? { agentId: null, round: 0, row: 0, col: 0 };
    if (!id) return;
    const key = `${rnd}:${r}:${c}`;
    if (lastKeyRef.current[id] === key) return;
    lastKeyRef.current[id] = key;
    setTrails((prev) => {
      const existing = prev[id] ?? [];
      const last = existing[existing.length - 1];
      if (last && last.row === r && last.col === c && last.round === rnd) return prev;
      const next = [...existing, { round: rnd, row: r, col: c }].slice(-TRAIL_MAX);
      return { ...prev, [id]: next };
    });
  }, []);

  useEffect(() => {
    if (!agentId) return;
    pendingRef.current = { agentId, round, row, col };
    // Defer flush to avoid synchronously calling setState inside the effect.
    const raf = requestAnimationFrame(flush);
    return () => cancelAnimationFrame(raf);
  }, [agentId, flush, round, row, col]);

  return trails;
}

function AgentTabs({
  agents,
  selected,
  onSelect,
  nameContext,
  positions,
}: {
  agents: string[];
  selected: string | null;
  onSelect: (id: string) => void;
  nameContext: Parameters<typeof formatAgentName>[1];
  positions: Record<string, TypologyResult>;
}) {
  return (
    <div className="flex flex-wrap gap-1.5 px-6 pt-5 pb-3 border-b border-[var(--color-line)]">
      {agents.map((agentId) => {
        const active = agentId === selected;
        const pos = positions[agentId];
        const accent = pos ? tileBorder(pos.row, pos.col) : 'rgba(233,220,190,0.18)';
        return (
          <button
            key={agentId}
            type="button"
            onClick={() => onSelect(agentId)}
            className={`group relative flex items-center gap-2 px-3 py-1.5 rounded-full border font-mono text-[10px] tracking-[0.14em] uppercase transition-colors ${
              active
                ? 'border-[var(--color-gold)] bg-[rgba(217,178,95,0.14)] text-[var(--color-gold)]'
                : 'border-[rgba(233,220,190,0.14)] bg-[rgba(11,23,34,0.6)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:border-[rgba(233,220,190,0.28)]'
            }`}
            title={formatAgentName(agentId, nameContext)}
          >
            <span
              className="w-1.5 h-1.5 rounded-full"
              style={{ backgroundColor: accent }}
              aria-hidden
            />
            <span>{shortName(agentId, nameContext)}</span>
          </button>
        );
      })}
    </div>
  );
}

function Spectrum({
  position,
  trail,
  onSelectTile,
}: {
  position: TypologyResult;
  trail: TrailEntry[];
  onSelectTile: (row: number, col: number) => void;
}) {
  const trailIndexMap = useMemo(() => {
    const map = new Map<string, number>();
    trail.forEach((entry, idx) => {
      map.set(`${entry.row}:${entry.col}`, idx);
    });
    return map;
  }, [trail]);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-[auto_1fr] gap-3 items-stretch">
        {/* Row labels + cells */}
        <div className="flex flex-col-reverse justify-between py-1 pr-1">
          {COOPERATION_LABELS.map((label, i) => (
            <div
              key={label}
              className={`font-mono text-[9px] tracking-[0.14em] uppercase leading-tight text-right ${
                i === position.row ? 'text-[var(--color-gold)]' : 'text-[var(--color-text-soft)]'
              }`}
            >
              {label}
            </div>
          ))}
        </div>
        <div
          className="grid gap-1.5"
          style={{
            gridTemplateColumns: `repeat(${SPECTRUM_SIZE}, minmax(0, 1fr))`,
            gridTemplateRows: `repeat(${SPECTRUM_SIZE}, minmax(0, 1fr))`,
          }}
        >
          {Array.from({ length: SPECTRUM_SIZE * SPECTRUM_SIZE }).map((_, idx) => {
            // Render rows top-down, but top row = highest cooperation (row index SPECTRUM_SIZE-1).
            const displayRow = Math.floor(idx / SPECTRUM_SIZE);
            const col = idx % SPECTRUM_SIZE;
            const row = SPECTRUM_SIZE - 1 - displayRow;
            const isCurrent = row === position.row && col === position.col;
            const trailIdx = trailIndexMap.get(`${row}:${col}`);
            const isTrail = trailIdx !== undefined && !(isCurrent && trailIdx === trail.length - 1);
            const bg = tileTone(row, col);
            const border = tileBorder(row, col);
            const trailOpacity =
              isTrail && trailIdx !== undefined && trail.length > 1
                ? 0.25 + (trailIdx / Math.max(1, trail.length - 1)) * 0.55
                : 0;
            return (
              <button
                type="button"
                key={`${row}-${col}`}
                className="relative aspect-square rounded-md border flex items-center justify-center transition-colors cursor-pointer p-0"
                style={{
                  backgroundColor: bg,
                  borderColor: isCurrent ? 'var(--color-gold)' : border,
                  boxShadow: isCurrent
                    ? '0 0 0 1px rgba(221,180,105,0.45), 0 0 18px rgba(221,180,105,0.25)'
                    : 'none',
                }}
                onClick={() => onSelectTile(row, col)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelectTile(row, col);
                  }
                }}
                title={describeTile(row, col)}
                aria-label={`${COOPERATION_LABELS[row]} · ${RELIABILITY_LABELS[col]}${
                  isCurrent ? ' (current)' : ''
                }`}
              >
                {isTrail && (
                  <span
                    className="absolute inset-1 rounded-sm"
                    style={{
                      backgroundColor: 'rgba(221,180,105,0.7)',
                      opacity: trailOpacity,
                    }}
                    aria-hidden
                  />
                )}
                {isCurrent && (
                  <span className="relative w-2.5 h-2.5 rounded-full bg-[var(--color-gold)] shadow-[0_0_12px_rgba(221,180,105,0.8)]" />
                )}
              </button>
            );
          })}
        </div>
      </div>
      {/* Column labels */}
      <div className="grid grid-cols-[auto_1fr] gap-3 items-start">
        <div className="w-[72px]" aria-hidden />
        <div
          className="grid gap-1.5 min-h-[42px]"
          style={{ gridTemplateColumns: `repeat(${SPECTRUM_SIZE}, minmax(0, 1fr))` }}
        >
          {RELIABILITY_LABELS.map((label, i) => (
            <div key={label} className="relative h-[42px] min-w-0">
              <span
                className={`absolute left-1/2 -translate-x-1/2 whitespace-nowrap font-mono text-[8px] tracking-[0.1em] uppercase text-center leading-none ${
                  i % 2 === 0 ? 'top-0' : 'bottom-0'
                } ${i === position.col ? 'text-[var(--color-gold)]' : 'text-[var(--color-text-soft)]'}`}
              >
                {label}
              </span>
            </div>
          ))}
        </div>
      </div>
      <div className="flex items-center justify-between text-[11px] text-[var(--color-text-muted)]">
        <span className="font-mono tracking-[0.14em] uppercase text-[9px] text-[var(--color-text-soft)]">
          Cooperation ↑ · Reliability →
        </span>
        <span className="font-mono tracking-[0.14em] uppercase text-[9px] text-[var(--color-text-soft)]">
          Trail: {trail.length} step{trail.length === 1 ? '' : 's'}
        </span>
      </div>
    </div>
  );
}

function FocusView({
  agentId,
  currentPosition,
  inspectTile,
  nameContext,
  onBack,
  recentCommitmentSummary,
  recentTags,
  trustCard,
}: {
  agentId: string;
  currentPosition: TypologyResult;
  inspectTile: { row: number; col: number } | null;
  nameContext: Parameters<typeof formatAgentName>[1];
  onBack: () => void;
  recentCommitmentSummary: string[];
  recentTags: string[];
  trustCard: TrustCard | null;
}) {
  const inspectedRow = inspectTile?.row ?? currentPosition.row;
  const inspectedCol = inspectTile?.col ?? currentPosition.col;
  const inspectingCurrent =
    inspectedRow === currentPosition.row && inspectedCol === currentPosition.col;
  const narrative = describeTile(inspectedRow, inspectedCol);
  const name = formatAgentName(agentId, nameContext);
  const inspectedCooperation = COOPERATION_LABELS[inspectedRow];
  const inspectedReliability = RELIABILITY_LABELS[inspectedCol];

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={onBack}
          className="px-3 py-1.5 rounded-full border border-[rgba(233,220,190,0.18)] bg-[rgba(11,23,34,0.6)] font-mono text-[10px] tracking-[0.18em] uppercase text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:border-[rgba(233,220,190,0.32)]"
        >
          ← Spectrum
        </button>
        <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-[var(--color-text-soft)]">
          Row {inspectedRow + 1} · Col {inspectedCol + 1}
          {!inspectingCurrent ? ' · Inspecting tile' : ''}
        </div>
      </div>

      <div
        className="rounded-[18px] border p-6 bg-gradient-to-br from-[rgba(18,33,48,0.92)] to-[rgba(10,18,28,0.88)]"
        style={{ borderColor: tileBorder(inspectedRow, inspectedCol) }}
      >
        <div className="font-mono text-[10px] tracking-[0.22em] uppercase text-[var(--color-text-soft)]">
          {name}
        </div>
        <div className="mt-1 font-serif text-2xl text-[var(--color-text)]">
          {inspectedCooperation} · {inspectedReliability}
        </div>
        <p className="mt-3 text-[14px] leading-[1.6] text-[var(--color-text-muted)]">{narrative}</p>
        {!inspectingCurrent && (
          <div className="mt-3 rounded-[14px] border border-[rgba(233,220,190,0.12)] bg-[rgba(11,23,34,0.42)] px-4 py-3 text-[12px] leading-[1.5] text-[var(--color-text-muted)]">
            <div className="font-mono text-[9px] tracking-[0.18em] uppercase text-[var(--color-text-soft)]">
              Current standing
            </div>
            <div className="mt-1 text-[13px] text-[var(--color-text)]">
              {currentPosition.cooperation} · {currentPosition.reliability}
            </div>
            <div className="mt-1">
              The detail lists below stay tied to this agent&apos;s live evidence, while the title
              above previews the clicked spectrum tile.
            </div>
          </div>
        )}

        <div className="mt-5 grid grid-cols-2 gap-4">
          <div>
            <div className="font-mono text-[9px] tracking-[0.18em] uppercase text-[var(--color-text-soft)] mb-1">
              Current cooperation signal
            </div>
            <div className="font-serif text-[17px] text-[var(--color-text)]">
              {currentPosition.cooperationScore.toFixed(2)}
            </div>
            <ul className="mt-2 space-y-1 text-[12px] text-[var(--color-text-muted)]">
              {currentPosition.reasons.cooperation.length > 0 ? (
                currentPosition.reasons.cooperation.map((line) => (
                  <li key={`cooperation-${line}`} className="leading-snug">
                    · {line}
                  </li>
                ))
              ) : (
                <li className="leading-snug italic">Waiting for cooperative signals.</li>
              )}
            </ul>
          </div>
          <div>
            <div className="font-mono text-[9px] tracking-[0.18em] uppercase text-[var(--color-text-soft)] mb-1">
              Current reliability signal
            </div>
            <div className="font-serif text-[17px] text-[var(--color-text)]">
              {currentPosition.reliabilityScore.toFixed(2)}
            </div>
            <ul className="mt-2 space-y-1 text-[12px] text-[var(--color-text-muted)]">
              {currentPosition.reasons.reliability.length > 0 ? (
                currentPosition.reasons.reliability.map((line) => (
                  <li key={`reliability-${line}`} className="leading-snug">
                    · {line}
                  </li>
                ))
              ) : (
                <li className="leading-snug italic">No delivery history on record yet.</li>
              )}
            </ul>
          </div>
        </div>
      </div>

      {(recentCommitmentSummary.length > 0 || recentTags.length > 0) && (
        <div className="rounded-[14px] border border-[rgba(233,220,190,0.12)] p-5 bg-[rgba(11,23,34,0.5)]">
          <div className="font-mono text-[10px] tracking-[0.2em] uppercase text-[var(--color-text-soft)]">
            Recent ledger signals
          </div>
          <ul className="mt-2 space-y-1.5 text-[13px] text-[var(--color-text-muted)] leading-[1.55]">
            {recentCommitmentSummary.map((line) => (
              <li key={`commitment-${line}`}>· {line}</li>
            ))}
            {recentTags.map((line) => (
              <li key={`tag-${line}`}>· {line}</li>
            ))}
          </ul>
        </div>
      )}

      {trustCard && (
        <div className="rounded-[14px] border border-[rgba(221,180,105,0.18)] p-5 bg-[rgba(17,29,41,0.66)]">
          <div className="font-mono text-[10px] tracking-[0.2em] uppercase text-[var(--color-gold)]">
            Agentic Trust Card
          </div>
          <div className="mt-2 font-serif text-[17px] text-[var(--color-text)]">
            {trustCard.headline}
          </div>
          <p className="mt-2 text-[13px] leading-[1.55] text-[var(--color-text-muted)]">
            {trustCard.summary}
          </p>
          {trustCard.signals.length > 0 && (
            <ul className="mt-3 space-y-2 text-[12px] leading-[1.45] text-[var(--color-text-muted)]">
              {trustCard.signals.slice(0, 3).map((signal) => (
                <li key={`${signal.label}-${signal.summary}`}>
                  <span className="font-mono text-[9px] tracking-[0.14em] uppercase text-[var(--color-text-soft)]">
                    {signal.stance}
                    {typeof signal.confidence === 'number'
                      ? ` · ${Math.round(signal.confidence * 100)}%`
                      : ''}
                  </span>
                  <div className="mt-0.5 text-[var(--color-text)]">{signal.label}</div>
                  <div>{signal.summary}</div>
                </li>
              ))}
            </ul>
          )}
          {trustCard.evidenceRefs.length > 0 && (
            <div className="mt-3 rounded-[12px] border border-[rgba(233,220,190,0.1)] px-3 py-2 text-[11px] leading-[1.45] text-[var(--color-text-soft)]">
              Evidence refs:{' '}
              {trustCard.evidenceRefs
                .slice(0, 2)
                .map((ref) => ref.summary ?? ref.id)
                .join(' · ')}
            </div>
          )}
          {trustCard.caveats.length > 0 && (
            <div className="mt-3 text-[11px] leading-[1.45] text-[var(--color-text-soft)]">
              {trustCard.caveats[0]}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function TrustGraph() {
  const trustMatrix = useGameStore((state) => state.gameState.trustMatrix);
  const agentsMap = useGameStore((state) => state.gameState.agents);
  const agentOrder = useGameStore((state) => state.gameState.agentOrder);
  const pendingAgentInfo = useGameStore((state) => state.gameState.pendingAgentInfo);
  const commitments = useGameStore((state) => state.gameState.commitments);
  const behaviorTags = useGameStore((state) => state.gameState.behaviorTags);
  const trustCards = useGameStore((state) => state.gameState.trustCards);
  const round = useGameStore((state) => state.gameState.round);

  const nameContext = useMemo(
    () => ({ agents: agentsMap, pendingAgentInfo }),
    [agentsMap, pendingAgentInfo],
  );

  const displayAgents = useMemo(() => {
    if (agentOrder.length > 0) return agentOrder;
    if (trustMatrix?.agents?.length) return trustMatrix.agents;
    return Object.keys(agentsMap);
  }, [agentOrder, trustMatrix, agentsMap]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focusOpen, setFocusOpen] = useState(false);
  const [focusedTile, setFocusedTile] = useState<{ row: number; col: number } | null>(null);

  // Sync selectedId when displayAgents changes. Defer via requestAnimationFrame
  // to avoid calling setState synchronously inside the effect.
  useEffect(() => {
    const syncSelected = () => {
      if (displayAgents.length === 0) {
        if (selectedId !== null) setSelectedId(null);
        return;
      }
      if (!selectedId || !displayAgents.includes(selectedId)) {
        const firstAgent = displayAgents[0];
        if (!firstAgent) return;
        setSelectedId(firstAgent);
        setFocusOpen(false);
        setFocusedTile(null);
      }
    };
    const raf = requestAnimationFrame(syncSelected);
    return () => cancelAnimationFrame(raf);
  }, [displayAgents, selectedId]);

  const positions = useMemo(() => {
    const out: Record<string, TypologyResult> = {};
    for (const id of displayAgents) {
      out[id] = computeTypology({
        agentId: id,
        globalTrust: agentsMap[id]?.trust ?? 0,
        peerScores: peerColumnFor(trustMatrix, id),
        commitments,
        behaviorTags,
      });
    }
    return out;
  }, [displayAgents, agentsMap, trustMatrix, commitments, behaviorTags]);

  const activePosition = selectedId ? positions[selectedId] : null;
  const activeTrustCard = useMemo(
    () => trustCards.find((card) => card.agentId === selectedId) ?? null,
    [selectedId, trustCards],
  );
  const trails = useAgentTrail(
    selectedId,
    round,
    activePosition?.row ?? 0,
    activePosition?.col ?? 0,
  );
  const activeTrail = selectedId ? (trails[selectedId] ?? []) : [];

  const recentCommitmentSummary = useMemo(() => {
    if (!selectedId) return [];
    return commitments
      .filter((c) => c.promisor === selectedId || c.counterparties?.includes(selectedId))
      .slice(0, 3)
      .map((c) => {
        const status = c.resolutionStatus ?? 'pending';
        const summary = c.summary ?? c.type ?? 'commitment';
        return `[${status}] ${summary}`;
      });
  }, [commitments, selectedId]);

  const recentTags = useMemo(() => {
    if (!selectedId) return [];
    return behaviorTags
      .filter((t) => t.actor === selectedId)
      .slice(0, 3)
      .map((t) => behaviorLabel(t));
  }, [behaviorTags, selectedId]);

  return (
    <section className="border border-[var(--color-line)] rounded-[var(--radius-xl)] overflow-hidden bg-gradient-to-b from-[rgba(12,24,36,0.92)] to-[rgba(8,16,24,0.86)] shadow-[var(--shadow)] backdrop-blur-[16px] min-h-0 flex flex-col h-full">
      <div className="flex justify-between items-start gap-5 p-6 px-7 border-b border-[var(--color-line)] bg-gradient-to-b from-[rgba(24,40,56,0.86)] to-[rgba(10,18,28,0.48)] shrink-0 max-[1600px]:flex-col max-[1600px]:items-start">
        <div>
          <div className="font-mono text-[10px] tracking-[0.24em] uppercase text-[var(--color-text-soft)] pl-1">
            Public Reputation Surface
          </div>
          <h2 className="mt-1 font-serif text-xl font-semibold text-[var(--color-text)]">
            Trust Spectrum
          </h2>
        </div>
        <div className="mt-1 text-[12px] leading-[1.45] text-[var(--color-text-muted)] text-right max-w-[220px]">
          A graduated read of each agent's standing — cooperation across reliability.
        </div>
      </div>

      {displayAgents.length === 0 || !activePosition ? (
        <div className="p-6 flex-1 overflow-auto custom-scrollbar">
          <div className="p-4 border border-dashed border-[rgba(233,220,190,0.12)] rounded-[18px] text-center text-[13px] leading-[1.5] text-[var(--color-text-muted)] bg-[rgba(10,20,30,0.36)]">
            No trust data available yet.
          </div>
        </div>
      ) : (
        <>
          <AgentTabs
            agents={displayAgents}
            selected={selectedId}
            onSelect={(id) => {
              setSelectedId(id);
              setFocusOpen(false);
              setFocusedTile(null);
            }}
            nameContext={nameContext}
            positions={positions}
          />
          <div className="p-6 flex-1 overflow-auto custom-scrollbar">
            {focusOpen && selectedId ? (
              <FocusView
                agentId={selectedId}
                currentPosition={activePosition}
                inspectTile={focusedTile}
                nameContext={nameContext}
                onBack={() => {
                  setFocusOpen(false);
                  setFocusedTile(null);
                }}
                recentCommitmentSummary={recentCommitmentSummary}
                recentTags={recentTags}
                trustCard={activeTrustCard}
              />
            ) : (
              <Spectrum
                position={activePosition}
                trail={activeTrail}
                onSelectTile={(row, col) => {
                  setFocusedTile({ row, col });
                  setFocusOpen(true);
                }}
              />
            )}
          </div>
        </>
      )}
    </section>
  );
}
