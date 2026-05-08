import { memo } from 'react';
import { useGameStore } from '../store';

const ParticipationCard = memo(function ParticipationCard() {
  const participationReadiness = useGameStore((state) => state.gameState.participationReadiness);

  const statusColor = (status: string) => {
    switch (status) {
      case 'active':
        return 'text-[#7fd389] bg-[rgba(127,211,137,0.15)] border-[rgba(127,211,137,0.25)]';
      case 'registered':
        return 'text-[var(--color-gold)] bg-[rgba(221,180,105,0.15)] border-[rgba(221,180,105,0.25)]';
      case 'inactive':
        return 'text-[var(--color-rose)] bg-[rgba(217,113,99,0.15)] border-[rgba(217,113,99,0.25)]';
      default:
        return 'text-[var(--color-text-soft)] bg-[rgba(144,132,144,0.15)] border-[rgba(144,132,144,0.25)]';
    }
  };

  return (
    <div className="p-6 rounded-[14px] border border-[var(--color-line)] bg-gradient-to-b from-[rgba(14,28,41,0.97)] to-[rgba(9,18,28,0.95)] shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]">
      <div className="flex justify-between items-center">
        <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-[var(--color-text-soft)]">
          Agent Participation
        </div>
        {participationReadiness.length > 0 && (
          <div className="font-mono text-[9px] tracking-[0.1em] text-[var(--color-text-soft)]">
            {participationReadiness.filter((p) => p.status === 'active').length}/
            {participationReadiness.length} active
          </div>
        )}
      </div>
      <div className="mt-3 space-y-2">
        {participationReadiness.length === 0 ? (
          <div className="p-3 border border-dashed border-[rgba(233,220,190,0.12)] rounded-[14px] text-xs text-[var(--color-text-muted)] bg-[rgba(10,20,30,0.36)]">
            No participation data available.
          </div>
        ) : (
          participationReadiness.slice(0, 6).map((participant) => (
            <article
              key={participant.agentId}
              className="p-3 rounded-[10px] border border-[rgba(233,220,190,0.08)] bg-[rgba(10,14,10,0.3)]"
            >
              <div className="flex justify-between items-center gap-2">
                <div className="flex items-center gap-2">
                  <div
                    className={`w-2 h-2 rounded-full ${
                      participant.mcpConnected ? 'bg-[#7fd389]' : 'bg-[var(--color-rose)]'
                    }`}
                  />
                  <span className="font-serif text-xs text-[var(--color-text)]">
                    {participant.agentId}
                  </span>
                </div>
                <span
                  className={`px-2 py-0.5 rounded-full text-[9px] tracking-[0.08em] uppercase ${statusColor(participant.status)}`}
                >
                  {participant.status}
                </span>
              </div>
              <div className="mt-1.5 grid grid-cols-3 gap-2 text-[9px] text-[var(--color-text-muted)]">
                {participant.trustScore !== undefined && (
                  <div>
                    <span className="text-[var(--color-text-soft)]">Trust:</span>{' '}
                    <span className="font-mono">{participant.trustScore.toFixed(2)}</span>
                  </div>
                )}
                {participant.gamesPlayed !== undefined && (
                  <div>
                    <span className="text-[var(--color-text-soft)]">Games:</span>{' '}
                    <span className="font-mono">{participant.gamesPlayed}</span>
                  </div>
                )}
                <div>
                  <span className="text-[var(--color-text-soft)]">MCP:</span>{' '}
                  <span>{participant.mcpConnected ? 'Yes' : 'No'}</span>
                </div>
              </div>
            </article>
          ))
        )}
      </div>
    </div>
  );
});

export default ParticipationCard;
