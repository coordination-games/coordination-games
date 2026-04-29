import { formatAgentName } from '../lib/format';
import { useGameStore } from '../store';

function statusClass(status: string | undefined) {
  if (status === 'fulfilled' || status === 'receive' || status === 'fulfill')
    return 'text-[#cbe6c7] bg-[rgba(126,172,115,0.16)] border-[rgba(126,172,115,0.22)]';
  if (status === 'breached' || status === 'breach' || status === 'contest')
    return 'text-[#efb4aa] bg-[rgba(217,113,99,0.16)] border-[rgba(217,113,99,0.22)]';
  if (status === 'pending' || status === 'candidate')
    return 'text-[#ecd6a8] bg-[rgba(217,178,95,0.16)] border-[rgba(217,178,95,0.22)]';
  return 'text-[var(--color-text-muted)] bg-[rgba(233,220,190,0.08)] border-[rgba(233,220,190,0.12)]';
}

function commitmentStatusLabel(status: string | undefined) {
  if (status === 'fulfilled' || status === 'receive' || status === 'fulfill') return 'Kept';
  if (status === 'breached' || status === 'breach' || status === 'contest') return 'Broken';
  if (status === 'attested') return 'Confirmed';
  return 'Open';
}

function proofStatusLabel(status: string | undefined) {
  if (status === 'fulfilled' || status === 'receive' || status === 'fulfill') return 'Confirmed';
  if (status === 'breached' || status === 'breach' || status === 'contest') return 'Disputed';
  if (status === 'attested') return 'Observed';
  return 'Not checked yet';
}

function roundLabel(phase: string | undefined) {
  const match = phase?.match(/^round_(\d+)$/);
  if (match?.[1]) return `Round ${match[1]}`;
  return phase ? phase.replace(/_/g, ' ') : 'Current round';
}

export function CommitmentLedger() {
  const commitments = useGameStore((state) => state.gameState.commitments);
  const attestations = useGameStore((state) => state.gameState.attestations);
  const agents = useGameStore((state) => state.gameState.agents);
  const pendingAgentInfo = useGameStore((state) => state.gameState.pendingAgentInfo);
  const context = { agents, pendingAgentInfo };
  const topCommitments = commitments.slice(0, 10);
  const topAttestations = attestations.slice(0, 10);

  return (
    <section className="border border-[var(--color-line)] rounded-[var(--radius-xl)] overflow-hidden bg-gradient-to-b from-[rgba(12,24,36,0.92)] to-[rgba(8,16,24,0.86)] shadow-[var(--shadow)] backdrop-blur-[16px] min-h-0 flex flex-col h-full">
      <div className="flex justify-between items-start gap-5 p-6 px-7 border-b border-[var(--color-line)] bg-gradient-to-b from-[rgba(24,40,56,0.86)] to-[rgba(10,18,28,0.48)] shrink-0 max-[1600px]:flex-col max-[1600px]:items-start">
        <div>
          <div className="font-mono text-[10px] tracking-[0.24em] uppercase text-[var(--color-text-soft)] pl-1">
            Visible promises
          </div>
          <h2 className="mt-1 font-serif text-xl font-semibold text-[var(--color-text)]">
            Promises
          </h2>
        </div>
        <div className="mt-1 text-[12px] leading-[1.55] text-[var(--color-text-muted)] text-right max-w-[240px] max-[1600px]:text-left">
          {commitments.length > 0
            ? `${commitments.length} visible promises tracked.`
            : 'Dialogue listener is waiting for explicit promises.'}
        </div>
      </div>

      <div className="p-6 flex-1 grid grid-cols-1 xl:grid-cols-2 gap-6 overflow-auto custom-scrollbar">
        <div>
          <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-[var(--color-text-soft)] mb-2">
            Commitments
          </div>
          <div className="grid gap-2.5">
            {topCommitments.length === 0 ? (
              <div className="p-4 border border-dashed border-[rgba(233,220,190,0.12)] rounded-[18px] text-center text-[13px] leading-[1.5] text-[var(--color-text-muted)] bg-[rgba(10,20,30,0.36)]">
                No commitments have been extracted yet.
              </div>
            ) : (
              topCommitments.map((item, index) => (
                <article
                  key={item.id}
                  className="p-5 rounded-[16px] border border-[rgba(233,220,190,0.08)] bg-gradient-to-b from-[rgba(14,26,39,0.84)] to-[rgba(8,16,24,0.76)]"
                >
                  <div className="flex justify-between items-start gap-2">
                    <span
                      className={`inline-flex items-center px-2 py-1 rounded-full font-mono text-[10px] tracking-[0.12em] uppercase border ${statusClass(item.resolutionStatus)}`}
                    >
                      {commitmentStatusLabel(item.resolutionStatus)}
                    </span>
                    <span className="font-mono text-[10px] tracking-[0.12em] uppercase text-[var(--color-text-soft)]">
                      Promise #{index + 1}
                    </span>
                  </div>
                  <div className="mt-2 font-serif text-[17px] text-[var(--color-text)]">
                    {item.summary || 'No summary provided.'}
                  </div>
                  <div className="mt-1 text-[13px] text-[var(--color-text-muted)]">
                    {formatAgentName(item.promisor, context)}
                    {item.counterparties && item.counterparties.length > 0
                      ? ` -> ${item.counterparties.map((id) => formatAgentName(id, context)).join(', ')}`
                      : ' -> Table'}
                  </div>
                </article>
              ))
            )}
          </div>
        </div>

        <div>
          <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-[var(--color-text-soft)] mb-2">
            Attestations
          </div>
          <div className="grid gap-2.5">
            {topAttestations.length === 0 ? (
              <div className="p-4 border border-dashed border-[rgba(233,220,190,0.12)] rounded-[18px] text-center text-[13px] leading-[1.5] text-[var(--color-text-muted)] bg-[rgba(10,20,30,0.36)]">
                No attestations have been published yet.
              </div>
            ) : (
              topAttestations.map((item, index) => (
                <article
                  key={item.id}
                  className="p-5 rounded-[16px] border border-[rgba(233,220,190,0.08)] bg-gradient-to-b from-[rgba(14,26,39,0.84)] to-[rgba(8,16,24,0.76)]"
                >
                  <div className="flex justify-between items-start gap-2">
                    <span
                      className={`inline-flex items-center px-2 py-1 rounded-full font-mono text-[10px] tracking-[0.12em] uppercase border ${statusClass(item.verdict)}`}
                    >
                      {proofStatusLabel(item.verdict)}
                    </span>
                    <span className="font-mono text-[10px] tracking-[0.12em] uppercase text-[var(--color-text-soft)]">
                      Proof #{index + 1}
                    </span>
                  </div>
                  <div className="mt-2 font-serif text-[17px] text-[var(--color-text)]">
                    {formatAgentName(item.actor, context)}
                  </div>
                  <div className="mt-1 text-[13px] text-[var(--color-text-muted)]">
                    {roundLabel(item.phase)} · visible promise check
                  </div>
                </article>
              ))
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
