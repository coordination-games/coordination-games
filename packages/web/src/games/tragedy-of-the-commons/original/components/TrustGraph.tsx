import { useEffect, useMemo, useState } from 'react';
import { formatAgentName, shortName } from '../lib/format';
import { type TrustCard, type TrustEvidenceRef, type TrustSignal, useGameStore } from '../store';

type NameContext = Parameters<typeof formatAgentName>[1];

const STANCE_LABEL: Record<TrustSignal['stance'], string> = {
  positive: 'Supportive',
  negative: 'Caution',
  informational: 'Context',
  unknown: 'Unrated',
};

const STANCE_CLASS: Record<TrustSignal['stance'], string> = {
  positive: 'border-[rgba(126,189,110,0.32)] bg-[rgba(91,148,92,0.13)] text-[#cbe6bb]',
  negative: 'border-[rgba(204,97,97,0.34)] bg-[rgba(176,79,82,0.13)] text-[#f0b8b8]',
  informational: 'border-[rgba(109,152,157,0.34)] bg-[rgba(109,152,157,0.12)] text-[#b9d7dc]',
  unknown:
    'border-[rgba(233,220,190,0.14)] bg-[rgba(233,220,190,0.08)] text-[var(--color-text-soft)]',
};

function formatConfidence(value: number | undefined): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}% confidence`;
}

function formatEvidenceRef(ref: TrustEvidenceRef): string {
  const parts = [ref.summary?.trim() || ref.id, ref.round ? `Round ${ref.round}` : '', ref.kind]
    .filter((part) => part.length > 0)
    .slice(0, 3);
  return parts.join(' · ');
}

function agentTrustCard(agentId: string, cards: TrustCard[]): TrustCard | null {
  return cards.find((card) => card.agentId === agentId || card.subjectId === agentId) ?? null;
}

function AgentTabs({
  agents,
  selected,
  onSelect,
  nameContext,
  cards,
}: {
  agents: string[];
  selected: string | null;
  onSelect: (id: string) => void;
  nameContext: NameContext;
  cards: TrustCard[];
}) {
  return (
    <div className="flex flex-wrap gap-1.5 px-6 pt-5 pb-3 border-b border-[var(--color-line)]">
      {agents.map((agentId) => {
        const active = agentId === selected;
        const card = agentTrustCard(agentId, cards);
        const hasCard = card !== null;

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
              className={`w-1.5 h-1.5 rounded-full ${
                hasCard ? 'bg-[var(--color-gold)]' : 'bg-[rgba(233,220,190,0.28)]'
              }`}
              aria-hidden
            />
            <span>{shortName(agentId, nameContext)}</span>
          </button>
        );
      })}
    </div>
  );
}

function SignalCard({ signal }: { signal: TrustSignal }) {
  const confidence = formatConfidence(signal.confidence);
  const refs = signal.evidenceRefs ?? [];

  return (
    <article className={`rounded-[16px] border p-4 ${STANCE_CLASS[signal.stance]}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="font-mono text-[9px] tracking-[0.18em] uppercase">
          {STANCE_LABEL[signal.stance]}
        </div>
        {confidence && (
          <div className="font-mono text-[9px] tracking-[0.14em] uppercase opacity-80">
            {confidence}
          </div>
        )}
      </div>
      <div className="mt-2 font-serif text-[17px] text-[var(--color-text)]">{signal.label}</div>
      <p className="mt-1 text-[13px] leading-[1.55] text-[var(--color-text-muted)]">
        {signal.summary}
      </p>
      {refs.length > 0 && (
        <div className="mt-3 space-y-1 rounded-[12px] border border-[rgba(233,220,190,0.1)] bg-[rgba(11,23,34,0.24)] px-3 py-2 text-[11px] leading-[1.45] text-[var(--color-text-soft)]">
          {refs.slice(0, 2).map((ref) => (
            <div key={`${ref.kind}-${ref.id}`}>{formatEvidenceRef(ref)}</div>
          ))}
        </div>
      )}
    </article>
  );
}

function EvidenceList({ refs }: { refs: TrustEvidenceRef[] }) {
  if (refs.length === 0) {
    return (
      <div className="rounded-[14px] border border-dashed border-[rgba(233,220,190,0.14)] bg-[rgba(11,23,34,0.28)] p-4 text-[13px] leading-[1.5] text-[var(--color-text-muted)]">
        No bounded evidence references are attached yet.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {refs.map((ref) => (
        <div
          key={`${ref.kind}-${ref.id}`}
          className="rounded-[14px] border border-[rgba(233,220,190,0.1)] bg-[rgba(11,23,34,0.36)] px-4 py-3"
        >
          <div className="font-mono text-[9px] tracking-[0.18em] uppercase text-[var(--color-text-soft)]">
            {ref.visibility === 'viewer-visible' ? 'Viewer-visible evidence' : 'Public evidence'}
          </div>
          <div className="mt-1 text-[13px] leading-[1.5] text-[var(--color-text)]">
            {formatEvidenceRef(ref)}
          </div>
        </div>
      ))}
    </div>
  );
}

function TrustCardPanel({
  agentId,
  card,
  nameContext,
}: {
  agentId: string;
  card: TrustCard | null;
  nameContext: NameContext;
}) {
  const name = formatAgentName(agentId, nameContext);

  if (!card) {
    return (
      <div className="rounded-[18px] border border-dashed border-[rgba(233,220,190,0.14)] bg-[rgba(10,20,30,0.36)] p-6 text-center">
        <div className="font-mono text-[10px] tracking-[0.2em] uppercase text-[var(--color-text-soft)]">
          {name}
        </div>
        <div className="mt-2 font-serif text-xl text-[var(--color-text)]">
          No agentic trust card yet
        </div>
        <p className="mx-auto mt-2 max-w-[420px] text-[13px] leading-[1.55] text-[var(--color-text-muted)]">
          This surface only renders compact trust cards from the visible game feed. It no longer
          invents a spectrum score from local UI heuristics.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <section className="rounded-[20px] border border-[rgba(221,180,105,0.2)] bg-gradient-to-br from-[rgba(18,33,48,0.9)] to-[rgba(10,18,28,0.86)] p-6">
        <div className="font-mono text-[10px] tracking-[0.22em] uppercase text-[var(--color-gold)]">
          Agentic Trust Card
        </div>
        <div className="mt-1 text-[12px] text-[var(--color-text-soft)]">{name}</div>
        <h3 className="mt-2 font-serif text-2xl text-[var(--color-text)]">{card.headline}</h3>
        <p className="mt-3 text-[14px] leading-[1.65] text-[var(--color-text-muted)]">
          {card.summary}
        </p>
      </section>

      <section>
        <div className="font-mono text-[10px] tracking-[0.2em] uppercase text-[var(--color-text-soft)]">
          Visible signals
        </div>
        <div className="mt-3 grid gap-3">
          {card.signals.length > 0 ? (
            card.signals.map((signal) => (
              <SignalCard key={`${signal.label}-${signal.summary}`} signal={signal} />
            ))
          ) : (
            <div className="rounded-[14px] border border-dashed border-[rgba(233,220,190,0.14)] bg-[rgba(11,23,34,0.28)] p-4 text-[13px] leading-[1.5] text-[var(--color-text-muted)]">
              No compact signals are available yet.
            </div>
          )}
        </div>
      </section>

      <section>
        <div className="font-mono text-[10px] tracking-[0.2em] uppercase text-[var(--color-text-soft)]">
          Evidence references
        </div>
        <div className="mt-3">
          <EvidenceList refs={card.evidenceRefs} />
        </div>
      </section>

      {card.caveats.length > 0 && (
        <section className="rounded-[16px] border border-[rgba(233,220,190,0.12)] bg-[rgba(11,23,34,0.42)] p-5">
          <div className="font-mono text-[10px] tracking-[0.2em] uppercase text-[var(--color-text-soft)]">
            Caveats
          </div>
          <ul className="mt-2 space-y-1.5 text-[12px] leading-[1.55] text-[var(--color-text-muted)]">
            {card.caveats.map((caveat) => (
              <li key={caveat}>· {caveat}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

export function TrustGraph() {
  const agentsMap = useGameStore((state) => state.gameState.agents);
  const agentOrder = useGameStore((state) => state.gameState.agentOrder);
  const pendingAgentInfo = useGameStore((state) => state.gameState.pendingAgentInfo);
  const trustCards = useGameStore((state) => state.gameState.trustCards);

  const nameContext = useMemo(
    () => ({ agents: agentsMap, pendingAgentInfo }),
    [agentsMap, pendingAgentInfo],
  );

  const displayAgents = useMemo(() => {
    const ordered = agentOrder.length > 0 ? agentOrder : Object.keys(agentsMap);
    const fromCards = trustCards.map((card) => card.agentId);
    return Array.from(new Set([...ordered, ...fromCards]));
  }, [agentOrder, agentsMap, trustCards]);

  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    const syncSelected = () => {
      if (displayAgents.length === 0) {
        if (selectedId !== null) setSelectedId(null);
        return;
      }
      if (!selectedId || !displayAgents.includes(selectedId)) {
        const firstAgent = displayAgents[0];
        if (firstAgent) setSelectedId(firstAgent);
      }
    };
    const raf = requestAnimationFrame(syncSelected);
    return () => cancelAnimationFrame(raf);
  }, [displayAgents, selectedId]);

  const activeTrustCard = useMemo(
    () => (selectedId ? agentTrustCard(selectedId, trustCards) : null),
    [selectedId, trustCards],
  );

  return (
    <section className="border border-[var(--color-line)] rounded-[var(--radius-xl)] overflow-hidden bg-gradient-to-b from-[rgba(12,24,36,0.92)] to-[rgba(8,16,24,0.86)] shadow-[var(--shadow)] backdrop-blur-[16px] min-h-0 flex flex-col h-full">
      <div className="flex justify-between items-start gap-5 p-6 px-7 border-b border-[var(--color-line)] bg-gradient-to-b from-[rgba(24,40,56,0.86)] to-[rgba(10,18,28,0.48)] shrink-0 max-[1600px]:flex-col max-[1600px]:items-start">
        <div>
          <div className="font-mono text-[10px] tracking-[0.24em] uppercase text-[var(--color-text-soft)] pl-1">
            Evidence-first reputation surface
          </div>
          <h2 className="mt-1 font-serif text-xl font-semibold text-[var(--color-text)]">
            Agentic Trust Cards
          </h2>
        </div>
        <div className="mt-1 text-[12px] leading-[1.45] text-[var(--color-text-muted)] text-right max-w-[250px]">
          Compact claims from visible game evidence. Not a synthetic score, ranking, or hidden
          reputation system.
        </div>
      </div>

      {displayAgents.length === 0 ? (
        <div className="p-6 flex-1 overflow-auto custom-scrollbar">
          <div className="p-4 border border-dashed border-[rgba(233,220,190,0.12)] rounded-[18px] text-center text-[13px] leading-[1.5] text-[var(--color-text-muted)] bg-[rgba(10,20,30,0.36)]">
            No trust cards available yet.
          </div>
        </div>
      ) : (
        <>
          <AgentTabs
            agents={displayAgents}
            selected={selectedId}
            onSelect={setSelectedId}
            nameContext={nameContext}
            cards={trustCards}
          />
          <div className="p-6 flex-1 overflow-auto custom-scrollbar">
            {selectedId && (
              <TrustCardPanel
                agentId={selectedId}
                card={activeTrustCard}
                nameContext={nameContext}
              />
            )}
          </div>
        </>
      )}
    </section>
  );
}
