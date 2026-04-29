import { memo } from 'react';
import { useGameStore } from '../store';

const IdentityCard = memo(function IdentityCard() {
  const agentIdentities = useGameStore((state) => state.gameState.agentIdentities);
  const identities = Object.values(agentIdentities);

  return (
    <div className="p-6 rounded-[14px] border border-[var(--color-line)] bg-gradient-to-b from-[rgba(14,28,41,0.97)] to-[rgba(9,18,28,0.95)] shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]">
      <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-[var(--color-text-soft)]">
        Agent Identities
      </div>
      <div className="mt-3 space-y-3">
        {identities.length === 0 ? (
          <div className="p-3 border border-dashed border-[rgba(233,220,190,0.12)] rounded-[14px] text-xs text-[var(--color-text-muted)] bg-[rgba(10,20,30,0.36)]">
            No agent identities registered.
          </div>
        ) : (
          identities.slice(0, 5).map((identity) => (
            <article
              key={identity.agentId}
              className="p-4 rounded-[12px] border border-[rgba(233,220,190,0.1)] bg-[rgba(10,14,10,0.4)]"
            >
              <div className="flex justify-between items-start gap-2">
                <div className="font-serif text-sm text-[var(--color-text)]">
                  {identity.name || identity.agentId}
                </div>
                {identity.chainId && (
                  <span className="font-mono text-[9px] tracking-[0.1em] uppercase px-2 py-0.5 rounded-full bg-[rgba(114,169,181,0.15)] text-[var(--color-sea)]">
                    Chain {identity.chainId}
                  </span>
                )}
              </div>
              <div className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-1 text-[10px] text-[var(--color-text-muted)]">
                <div>
                  <span className="text-[var(--color-text-soft)]">ID:</span>{' '}
                  <span className="font-mono">{identity.agentId.slice(0, 12)}...</span>
                </div>
                {identity.mcpEndpoint && (
                  <div>
                    <span className="text-[var(--color-text-soft)]">MCP:</span>{' '}
                    <span className="truncate">{identity.mcpEndpoint.slice(0, 20)}</span>
                  </div>
                )}
              </div>
              {identity.capabilities && identity.capabilities.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {identity.capabilities.slice(0, 3).map((cap) => (
                    <span
                      key={cap}
                      className="px-2 py-0.5 rounded-full text-[9px] bg-[rgba(126,172,115,0.15)] text-[var(--color-moss)] border border-[rgba(126,172,115,0.2)]"
                    >
                      {cap}
                    </span>
                  ))}
                </div>
              )}
            </article>
          ))
        )}
      </div>
    </div>
  );
});

export default IdentityCard;
