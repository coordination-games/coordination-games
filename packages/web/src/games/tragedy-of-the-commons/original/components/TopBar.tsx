import { useGameStore } from '../store';

export function TopBar() {
  const round = useGameStore((state) => state.gameState.round);
  const phase = useGameStore((state) => state.gameState.phase);
  const prizePoolWei = useGameStore((state) => state.gameState.prizePoolWei);
  const payablePrizePoolWei = useGameStore((state) => state.gameState.payablePrizePoolWei);
  const slashedPrizePoolWei = useGameStore((state) => state.gameState.slashedPrizePoolWei);
  const commonsHealth = useGameStore((state) => state.gameState.commonsHealth);
  const connectionStatus = useGameStore((state) => state.connectionStatus);

  const formatEth = (wei: string) => {
    try {
      const eth = Number(wei) / 1e18;
      return `${eth.toFixed(3)} ETH`;
    } catch {
      return '0.000 ETH';
    }
  };

  return (
    <div className="flex flex-col gap-5 z-10 relative">
      <header className="flex items-center justify-between gap-4 px-7 py-3.5 border border-[var(--color-line)] rounded-[20px] overflow-hidden bg-gradient-to-br from-[rgba(12,28,42,0.94)] to-[rgba(10,18,28,0.92)] shadow-[var(--shadow)] backdrop-blur-[18px] relative max-[1500px]:flex-col max-[1500px]:items-start">
        <div className="absolute inset-0 pointer-events-none bg-[radial-gradient(circle_at_14%_50%,rgba(221,180,105,0.12),transparent_18%),radial-gradient(circle_at_88%_50%,rgba(114,169,181,0.10),transparent_16%),linear-gradient(90deg,transparent_0%,rgba(255,255,255,0.02)_48%,transparent_100%)]" />

        <div className="relative z-10 max-w-[780px]">
          <div className="font-mono text-[10px] tracking-[0.28em] uppercase text-[var(--color-text-soft)] mb-1">
            AI Coordination Observatory
          </div>
          <h1 className="font-serif text-[clamp(22px,3vw,34px)] leading-none tracking-[0.01em] font-bold text-[var(--color-text)] text-balance drop-shadow-[0_8px_20px_rgba(0,0,0,0.28)]">
            Tragedy of the Commons
          </h1>
          <p className="mt-1.5 max-w-[680px] text-[13px] leading-relaxed text-[var(--color-text-muted)]">
            A live strategy atlas where private bargains, public betrayals, and ecological collapse
            all become visible. The table can win the round while still burning down the world that
            pays it.
          </p>
        </div>

        <div className="relative z-10 flex flex-row items-center gap-5 shrink-0 max-[1500px]:w-full max-[1500px]:justify-between max-[900px]:flex-col max-[900px]:items-stretch">
          <div className="px-4 py-3 border border-[var(--color-line)] rounded-xl overflow-hidden bg-gradient-to-b from-[rgba(239,223,192,0.05)] to-[rgba(12,20,30,0.5)]">
            <div className="flex items-center gap-2.5 font-mono text-xs tracking-[0.14em] uppercase text-[var(--color-text)]">
              <span
                className={`w-[11px] h-[11px] rounded-full shrink-0 transition-all duration-200 ${
                  connectionStatus === 'connected'
                    ? 'bg-[#7fd389] shadow-[0_0_0_5px_rgba(127,211,137,0.12),0_0_18px_rgba(127,211,137,0.35)]'
                    : connectionStatus === 'connecting'
                      ? 'bg-[var(--color-gold)] shadow-[0_0_0_5px_rgba(221,180,105,0.12)]'
                      : 'bg-[var(--color-rose)] shadow-[0_0_0_5px_rgba(217,113,99,0.12)]'
                }`}
              />
              <span>{connectionStatus}</span>
            </div>
            <div className="mt-1 text-[11px] leading-[1.3] text-[var(--color-text-muted)]">
              Native Lucian spectator stream.
            </div>
          </div>
        </div>
      </header>

      <section className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-5">
        <MetricCard
          label="Round"
          value={round > 0 ? round.toString() : 'Standby'}
          meta={round > 0 ? 'Active match' : 'No active match'}
          emphasis
        />
        <MetricCard
          label="Phase"
          value={phase.charAt(0).toUpperCase() + phase.slice(1)}
          meta="Negotiation and action feed will stream here."
        />
        <MetricCard
          label="Current Pot"
          value={formatEth(prizePoolWei)}
          meta="Entry and move fees accumulate here."
        />
        <MetricCard
          label="Payable Pot"
          value={formatEth(payablePrizePoolWei)}
          meta="What survives after commons damage."
        />
        <MetricCard
          label="Slashed Forward"
          value={formatEth(slashedPrizePoolWei)}
          meta="Damage carries into the next game."
        />
        <MetricCard
          label="Commons Pressure"
          value={commonsHealth ? `${commonsHealth.score} / 100` : '100 / 100'}
          meta="Payout-adjusted aggregate after crisis and sabotage pressure."
        />
      </section>
    </div>
  );
}

function MetricCard({
  label,
  value,
  meta,
  emphasis = false,
}: {
  label: string;
  value: string;
  meta: string;
  emphasis?: boolean;
}) {
  return (
    <article
      className={`px-5 py-3.5 border border-[var(--color-line)] rounded-2xl overflow-hidden shadow-[var(--shadow)] backdrop-blur-[16px] min-h-0 relative ${
        emphasis
          ? 'bg-[linear-gradient(140deg,rgba(221,180,105,0.2),rgba(114,169,181,0.08)),linear-gradient(180deg,rgba(14,27,40,0.94),rgba(8,18,28,0.88))]'
          : 'bg-gradient-to-b from-[rgba(14,27,40,0.92)] to-[rgba(8,18,28,0.82)]'
      }`}
    >
      <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-[var(--color-text-soft)]">
        {label}
      </div>
      <div className="mt-1.5 font-serif text-[clamp(18px,2vw,24px)] leading-none text-[var(--color-text)]">
        {value}
      </div>
      <div className="mt-1.5 text-[12px] leading-[1.4] text-[var(--color-text-muted)]">{meta}</div>
    </article>
  );
}
