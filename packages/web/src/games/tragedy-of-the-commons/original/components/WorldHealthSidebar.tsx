import { useGameStore } from '../store';

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function formatHealth(value: number) {
  return Math.round(value);
}

function formatEth(value: string) {
  try {
    const wei = BigInt(String(value || '0'));
    const whole = wei / 1000000000000000000n;
    const decimals = (wei % 1000000000000000000n)
      .toString()
      .padStart(18, '0')
      .slice(0, 3)
      .replace(/0+$/, '');
    return `${whole.toString()}${decimals ? `.${decimals}` : ''} ETH`;
  } catch {
    return '0.000 ETH';
  }
}

export function WorldHealthSidebar() {
  const commonsHealth = useGameStore((state) => state.gameState.commonsHealth);
  const ecosystemStates = useGameStore((state) => state.gameState.ecosystemStates);
  const prizePoolWei = useGameStore((state) => state.gameState.prizePoolWei);
  const payablePrizePoolWei = useGameStore((state) => state.gameState.payablePrizePoolWei);
  const slashedPrizePoolWei = useGameStore((state) => state.gameState.slashedPrizePoolWei);
  const carryoverPrizePoolWei = useGameStore((state) => state.gameState.carryoverPrizePoolWei);
  const score = clamp(commonsHealth?.score ?? 100, 0, 100);
  const ecosystems = [...ecosystemStates]
    .map(
      (eco) =>
        eco as {
          id?: string;
          name?: string;
          kind?: string;
          health?: number;
          maxHealth?: number;
          status?: string;
        },
    )
    .sort((a, b) => Number(a.health ?? 100) - Number(b.health ?? 100));
  const rawAverage = ecosystems.length
    ? Math.round(
        ecosystems.reduce(
          (total, eco) =>
            total + clamp(Number(eco.health ?? 100), 0, Number(eco.maxHealth ?? 100) || 100),
          0,
        ) / ecosystems.length,
      )
    : 100;

  return (
    <aside className="w-full min-w-0 grid gap-5 overflow-y-auto max-h-[600px]">
      <div className="p-6 rounded-[14px] border border-[var(--color-line)] bg-gradient-to-b from-[rgba(14,28,41,0.97)] to-[rgba(9,18,28,0.95)] shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]">
        <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-[var(--color-text-soft)]">
          Commons Pressure
        </div>
        <div className="mt-3 h-3 rounded-full overflow-hidden border border-[var(--color-line)] bg-[rgba(0,0,0,0.22)]">
          <div
            className="h-full rounded-full bg-gradient-to-r from-[var(--color-rose)] via-[var(--color-gold)] to-[var(--color-moss)]"
            style={{ width: `${score}%` }}
          />
        </div>
        <div className="mt-2 font-serif text-[22px] leading-none text-[var(--color-text)]">
          {score} / 100
        </div>
        <div className="mt-2 text-xs leading-[1.4] text-[var(--color-text-muted)]">
          {commonsHealth?.reasons?.[0] ??
            'This is the payout-adjusted aggregate after crisis and sabotage penalties.'}
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3 text-[11px]">
          <div className="rounded-[12px] border border-[rgba(233,220,190,0.08)] bg-[rgba(10,20,30,0.35)] px-3 py-2">
            <div className="font-mono uppercase tracking-[0.14em] text-[var(--color-text-soft)]">
              Raw ecosystem avg
            </div>
            <div className="mt-1 font-serif text-[16px] text-[var(--color-text)]">
              {rawAverage} / 100
            </div>
          </div>
          <div className="rounded-[12px] border border-[rgba(233,220,190,0.08)] bg-[rgba(10,20,30,0.35)] px-3 py-2">
            <div className="font-mono uppercase tracking-[0.14em] text-[var(--color-text-soft)]">
              Payout fraction
            </div>
            <div className="mt-1 font-serif text-[16px] text-[var(--color-text)]">
              {Math.round((commonsHealth?.payableFraction ?? 1) * 100)}%
            </div>
          </div>
        </div>

        <div className="grid gap-4 mt-4">
          {ecosystems.length === 0 ? (
            <div className="p-3 border border-dashed border-[rgba(233,220,190,0.12)] rounded-[14px] text-xs text-[var(--color-text-muted)] bg-[rgba(10,20,30,0.36)]">
              Shared ecosystem health appears after state updates.
            </div>
          ) : (
            ecosystems.map((eco) => {
              const maxHealth = Number(eco.maxHealth ?? 100) || 100;
              const health = clamp(Number(eco.health ?? 100), 0, maxHealth);
              const width = (health / maxHealth) * 100;
              const displayHealth = formatHealth(health);
              const displayMaxHealth = formatHealth(maxHealth);
              return (
                <article
                  key={eco.id ?? eco.name}
                  className="p-4 rounded-[14px] border border-[rgba(233,220,190,0.1)] bg-[rgba(10,14,10,0.4)]"
                >
                  <div className="flex justify-between items-center gap-2">
                    <div className="font-serif text-base text-[var(--color-text)]">
                      {eco.name ?? eco.id}
                    </div>
                    <div className="font-mono text-[10px] tracking-[0.12em] uppercase text-[var(--color-text-soft)]">
                      {eco.status ?? eco.kind ?? 'stable'}
                    </div>
                  </div>
                  <div className="mt-2 h-2.5 rounded-full overflow-hidden border border-[rgba(233,220,190,0.12)] bg-[rgba(0,0,0,0.24)]">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-[var(--color-rose)] via-[var(--color-gold)] to-[var(--color-moss)]"
                      style={{ width: `${width}%` }}
                    />
                  </div>
                  <div className="mt-2 text-[11px] text-[var(--color-text-muted)]">
                    Raw ecosystem health: {displayHealth} / {displayMaxHealth}
                  </div>
                </article>
              );
            })
          )}
        </div>
      </div>

      <div className="p-6 rounded-[14px] border border-[var(--color-line)] bg-gradient-to-b from-[rgba(14,28,41,0.97)] to-[rgba(9,18,28,0.95)] shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]">
        <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-[var(--color-text-soft)]">
          Prize Pressure
        </div>
        <div className="grid gap-1.5 mt-2 text-xs text-[var(--color-text-muted)]">
          <div className="flex justify-between">
            <span>Current pool</span>
            <strong className="text-[var(--color-text)]">{formatEth(prizePoolWei)}</strong>
          </div>
          <div className="flex justify-between">
            <span>Payable now</span>
            <strong className="text-[var(--color-text)]">{formatEth(payablePrizePoolWei)}</strong>
          </div>
          <div className="flex justify-between">
            <span>Slashed ahead</span>
            <strong className="text-[var(--color-text)]">{formatEth(slashedPrizePoolWei)}</strong>
          </div>
          <div className="flex justify-between">
            <span>Carryover next game</span>
            <strong className="text-[var(--color-text)]">{formatEth(carryoverPrizePoolWei)}</strong>
          </div>
        </div>
      </div>
    </aside>
  );
}
