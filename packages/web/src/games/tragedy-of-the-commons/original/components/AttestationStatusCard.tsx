import { memo } from 'react';
import { useGameStore } from '../store';

const AttestationStatusCard = memo(function AttestationStatusCard() {
  const attestationReadiness = useGameStore((state) => state.gameState.attestationReadiness);

  const trendColor = (delta?: number) => {
    if (delta === undefined) return 'text-[var(--color-text-soft)]';
    if (delta > 0) return 'text-[#7fd389]';
    if (delta < 0) return 'text-[var(--color-rose)]';
    return 'text-[var(--color-text-soft)]';
  };

  const badgeColor = (placement?: number) => {
    if (placement === 1)
      return 'bg-[rgba(221,180,105,0.2)] text-[var(--color-gold)] border-[rgba(221,180,105,0.4)]';
    if (placement === 2)
      return 'bg-[rgba(192,192,192,0.15)] text-[#c0c0c0] border-[rgba(192,192,192,0.3)]';
    if (placement === 3)
      return 'bg-[rgba(205,127,50,0.15)] text-[#cd7f32] border-[rgba(205,127,50,0.3)]';
    return 'bg-[rgba(144,132,144,0.15)] text-[var(--color-text-soft)] border-[rgba(144,132,144,0.25)]';
  };

  return (
    <div className="p-6 rounded-[14px] border border-[var(--color-line)] bg-gradient-to-b from-[rgba(14,28,41,0.97)] to-[rgba(9,18,28,0.95)] shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]">
      <div className="flex justify-between items-center">
        <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-[var(--color-text-soft)]">
          Attestation Status
        </div>
        {attestationReadiness.length > 0 && (
          <div className="font-mono text-[9px] tracking-[0.1em] text-[var(--color-text-soft)]">
            {attestationReadiness.length} attested
          </div>
        )}
      </div>
      <div className="mt-3 space-y-2">
        {attestationReadiness.length === 0 ? (
          <div className="p-3 border border-dashed border-[rgba(233,220,190,0.12)] rounded-[14px] text-xs text-[var(--color-text-muted)] bg-[rgba(10,20,30,0.36)]">
            No attestation data available.
          </div>
        ) : (
          attestationReadiness.slice(0, 5).map((attestation) => (
            <article
              key={attestation.uid}
              className="p-3 rounded-[10px] border border-[rgba(233,220,190,0.08)] bg-[rgba(10,14,10,0.3)]"
            >
              <div className="flex justify-between items-center gap-2">
                <span className="font-serif text-xs text-[var(--color-text)]">
                  {attestation.agentId}
                </span>
                <span
                  className={`px-2 py-0.5 rounded-full text-[9px] tracking-[0.08em] uppercase border ${badgeColor(attestation.placement)}`}
                >
                  {attestation.placement ? `#${attestation.placement}` : '—'}
                </span>
              </div>
              <div className="mt-1.5 grid grid-cols-4 gap-2 text-[9px] text-[var(--color-text-muted)]">
                {attestation.score !== undefined && (
                  <div>
                    <span className="text-[var(--color-text-soft)]">Score:</span>{' '}
                    <span className="font-mono">{attestation.score}</span>
                  </div>
                )}
                {attestation.trustDelta !== undefined && (
                  <div>
                    <span className="text-[var(--color-text-soft)]">Δ:</span>{' '}
                    <span className={`font-mono ${trendColor(attestation.trustDelta)}`}>
                      {attestation.trustDelta > 0 ? '+' : ''}
                      {attestation.trustDelta.toFixed(2)}
                    </span>
                  </div>
                )}
                {attestation.cooperationRate !== undefined && (
                  <div>
                    <span className="text-[var(--color-text-soft)]">Coop:</span>{' '}
                    <span className="font-mono">
                      {(attestation.cooperationRate * 100).toFixed(0)}%
                    </span>
                  </div>
                )}
                {attestation.betrayalCount !== undefined && (
                  <div>
                    <span className="text-[var(--color-text-soft)]">Betray:</span>{' '}
                    <span className="font-mono">{attestation.betrayalCount}</span>
                  </div>
                )}
              </div>
            </article>
          ))
        )}
      </div>
    </div>
  );
});

export default AttestationStatusCard;
