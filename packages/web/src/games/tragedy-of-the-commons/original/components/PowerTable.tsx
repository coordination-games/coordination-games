import { formatAgentName } from '../lib/format';
import { useGameStore } from '../store';

export function PowerTable() {
  const agents = useGameStore((state) => state.gameState.agents);
  const pendingAgentInfo = useGameStore((state) => state.gameState.pendingAgentInfo);
  const agentOrder = useGameStore((state) => state.gameState.agentOrder);
  const winnerId = useGameStore((state) => state.gameState.winnerId);
  const context = { agents, pendingAgentInfo };

  return (
    <section className="border border-[var(--color-line)] rounded-[var(--radius-xl)] overflow-hidden bg-gradient-to-b from-[rgba(12,24,36,0.92)] to-[rgba(8,16,24,0.86)] shadow-[var(--shadow)] backdrop-blur-[16px] min-h-0 flex flex-col h-full">
      <div className="flex justify-between items-start gap-5 p-6 px-7 border-b border-[var(--color-line)] bg-gradient-to-b from-[rgba(24,40,56,0.86)] to-[rgba(10,18,28,0.48)] max-[1600px]:flex-col max-[1600px]:items-start">
        <div>
          <div className="font-mono text-[10px] tracking-[0.24em] uppercase text-[var(--color-text-soft)] pl-1">
            Competitive Field
          </div>
          <h2 className="mt-1 font-serif text-xl font-semibold text-[var(--color-text)]">
            Power Table
          </h2>
        </div>
        <div className="mt-1 text-[12px] leading-[1.55] text-[var(--color-text-muted)] text-right max-w-[220px] max-[1600px]:text-left">
          Agents still compete, even when trust is high.
        </div>
      </div>

      <div className="p-6 flex-1 flex flex-col gap-5 overflow-y-auto custom-scrollbar">
        {agentOrder.map((agentId, index) => {
          const agent = agents[agentId] || {};
          const isTop = index === 0;
          const isWinner = winnerId === agentId;

          return (
            <div
              key={agentId}
              className={`p-5 px-6 rounded-[14px] border bg-gradient-to-br from-[rgba(18,33,48,0.96)] to-[rgba(10,18,28,0.9)] ${
                isTop || isWinner
                  ? 'border-[rgba(217,178,95,0.28)] shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_16px_24px_rgba(0,0,0,0.2)]'
                  : 'border-[rgba(233,220,190,0.12)] shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]'
              }`}
            >
              <div className="flex justify-between gap-2.5 items-start">
                <div className="flex flex-col gap-1 min-w-0">
                  <div className="font-serif text-[17px] leading-none text-[var(--color-text)] whitespace-nowrap overflow-hidden text-ellipsis flex items-center gap-2">
                    {formatAgentName(agentId, context)}
                    {isWinner && (
                      <span className="px-2 py-0.5 rounded-full bg-[rgba(217,178,95,0.2)] border border-[rgba(217,178,95,0.4)] font-mono text-[9px] tracking-[0.1em] uppercase text-[var(--color-gold)]">
                        Winner
                      </span>
                    )}
                  </div>
                  <div className="font-mono text-[10px] tracking-[0.16em] uppercase text-[var(--color-text-soft)]">
                    {agent.strategy || 'Unknown'}
                  </div>
                </div>
                <div className="shrink-0 px-2.5 py-1.5 rounded-full bg-[rgba(217,178,95,0.14)] border border-[rgba(217,178,95,0.2)] font-mono text-[10px] tracking-[0.16em] uppercase text-[var(--color-gold)]">
                  Rank {index + 1}
                </div>
              </div>

              <div className="mt-3.5 flex justify-between gap-2.5 items-start">
                <div className="grid gap-2 min-w-0">
                  <div className="flex items-baseline gap-4">
                    <div className="flex items-baseline gap-2">
                      <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-[var(--color-text-soft)]">
                        VP
                      </div>
                      <div className="font-serif text-xl leading-none text-[var(--color-text)]">
                        {agent.vp || 0}
                      </div>
                    </div>
                    <div className="flex items-baseline gap-2">
                      <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-[var(--color-text-soft)]">
                        INF
                      </div>
                      <div className="font-serif text-xl leading-none text-[var(--color-text)]">
                        {agent.influence || 0}
                      </div>
                    </div>
                    <div className="flex items-baseline gap-2">
                      <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-[var(--color-text-soft)]">
                        TRUST
                      </div>
                      <div className="font-serif text-xl leading-none text-[var(--color-text)]">
                        {Number(agent.trust || 0).toFixed(2)}
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3.5 mt-4">
                {[
                  { key: 'grain', label: 'GR', color: '#c3a75a' },
                  { key: 'timber', label: 'TI', color: '#74a56b' },
                  { key: 'ore', label: 'OR', color: '#8a82b6' },
                  { key: 'fish', label: 'FI', color: '#63a5a7' },
                  { key: 'water', label: 'WA', color: '#7ec0cf' },
                  { key: 'energy', label: 'EN', color: '#d9b25f' },
                ].map((res) => (
                  <div
                    key={res.key}
                    className="rounded-xl p-3 border border-[rgba(233,220,190,0.1)] bg-[rgba(8,12,8,0.26)] text-center flex flex-col items-center gap-1.5"
                  >
                    <div className="flex items-center gap-1">
                      <div
                        className="w-2 h-2 rounded-full"
                        style={{ backgroundColor: res.color }}
                      ></div>
                      <div className="font-mono text-[9px] tracking-[0.14em] uppercase text-[var(--color-text-soft)]">
                        {res.label}
                      </div>
                    </div>
                    <div className="mt-1 text-sm text-[var(--color-text)]">
                      {agent.resources?.[res.key] || 0}
                    </div>
                  </div>
                ))}
              </div>

              <div className="flex flex-wrap gap-3 mt-4">
                {[
                  { key: 'villages', label: 'Village' },
                  { key: 'townships', label: 'Township' },
                  { key: 'cities', label: 'City' },
                  { key: 'beacons', label: 'Beacon' },
                  { key: 'tradePosts', label: 'Post' },
                  { key: 'roads', label: 'Road' },
                ].map((struct) => {
                  const count =
                    agent.structures?.[struct.key as keyof NonNullable<typeof agent.structures>] ||
                    0;
                  if (count === 0) return null;
                  return (
                    <div
                      key={struct.key}
                      className="px-3 py-1.5 rounded-full border border-[rgba(233,220,190,0.12)] bg-[rgba(33,43,33,0.5)] text-[10px] text-[var(--color-text-muted)]"
                    >
                      {count} {struct.label}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
