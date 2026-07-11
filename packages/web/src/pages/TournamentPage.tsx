import { useParams } from 'react-router-dom';
import {
  Amount,
  CopyHash,
  EconRow,
  PlayerBadge,
  PolicyCard,
  SectionEyebrow,
  StatusBadge,
} from '../tournament/components.js';
import { bpsToPercent, groupInt } from '../tournament/format.js';
import type { Economics, Settlement, Standing, TournamentState } from '../tournament/parse.js';
import { useTournamentState } from '../tournament/useTournamentState.js';

function MonoNote({ children }: { children: React.ReactNode }) {
  return (
    <p
      className="font-mono text-[11px] tracking-[0.22em] uppercase"
      style={{ color: 'var(--color-graphite)' }}
    >
      <span style={{ color: 'var(--color-mint-text)' }}>{'// '}</span>
      {children}
    </p>
  );
}

function StateBlock({ children }: { children: React.ReactNode }) {
  return (
    <div className="py-16 text-center" style={{ border: '1px dashed var(--color-stone)' }}>
      {children}
    </div>
  );
}

function Header({ state }: { state: TournamentState }) {
  return (
    <header className="dark-card p-6 sm:p-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div
            className="font-mono text-[10px] tracking-[0.22em] uppercase"
            style={{ color: 'var(--color-ash)' }}
          >
            {state.gameType}
          </div>
          <h1
            className="font-display text-3xl sm:text-4xl font-medium tracking-tight mt-1"
            style={{ color: 'var(--color-bone)' }}
          >
            {state.tournamentId}
          </h1>
        </div>
        <StatusBadge status={state.status} />
      </div>
      <div className="hairline-dark my-5" />
      <dl className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div>
          <dt
            className="font-mono text-[10px] tracking-[0.18em] uppercase"
            style={{ color: 'var(--color-ash)' }}
          >
            Current game
          </dt>
          <dd className="font-mono text-sm mt-1" style={{ color: 'var(--color-mint)' }}>
            {state.currentGameId ?? '—'}
          </dd>
        </div>
        <div>
          <dt
            className="font-mono text-[10px] tracking-[0.18em] uppercase"
            style={{ color: 'var(--color-ash)' }}
          >
            Game index
          </dt>
          <dd className="font-mono text-sm mt-1" style={{ color: 'var(--color-bone)' }}>
            {state.currentGameIndex ?? '—'}
          </dd>
        </div>
        <div>
          <dt
            className="font-mono text-[10px] tracking-[0.18em] uppercase"
            style={{ color: 'var(--color-ash)' }}
          >
            Active
          </dt>
          <dd className="font-mono text-sm mt-1" style={{ color: 'var(--color-bone)' }}>
            {state.activePlayerIds.length}
          </dd>
        </div>
        <div>
          <dt
            className="font-mono text-[10px] tracking-[0.18em] uppercase"
            style={{ color: 'var(--color-ash)' }}
          >
            Treasury carry
          </dt>
          <dd
            className="font-mono text-sm mt-1 tabular-nums"
            style={{ color: 'var(--color-mint)' }}
          >
            {groupInt(state.treasuryCarry)}
          </dd>
        </div>
      </dl>
    </header>
  );
}

function StandingsTable({ state }: { state: TournamentState }) {
  const eliminated = new Set(state.eliminatedPlayerIds);
  return (
    <section className="space-y-4">
      <SectionEyebrow num="01" label="Standings" />
      <div className="overflow-x-auto" style={{ border: '1px solid rgba(28,26,23,0.1)' }}>
        <table className="w-full text-sm">
          <caption className="sr-only">Tournament standings in leaderboard order</caption>
          <thead>
            <tr
              className="text-left font-mono text-[10px] uppercase tracking-[0.18em]"
              style={{
                borderBottom: '1px solid rgba(28,26,23,0.12)',
                color: 'var(--color-graphite)',
                background: 'var(--color-bone)',
              }}
            >
              <th scope="col" className="px-3 sm:px-5 py-3 w-12">
                #
              </th>
              <th scope="col" className="px-3 sm:px-5 py-3">
                Player
              </th>
              <th scope="col" className="px-3 sm:px-5 py-3">
                Status
              </th>
              <th scope="col" className="hidden sm:table-cell px-5 py-3 text-right">
                Games
              </th>
              <th
                scope="col"
                className="px-3 sm:px-5 pr-4 sm:pr-6 py-3 text-right whitespace-nowrap"
              >
                Cumulative Δ
              </th>
            </tr>
          </thead>
          <tbody>
            {state.standings.map((s: Standing, i) => (
              <tr
                key={s.playerId}
                style={{
                  borderBottom: '1px solid rgba(28,26,23,0.06)',
                  background: 'var(--color-bone)',
                }}
              >
                <td
                  className="px-3 sm:px-5 py-3 font-mono text-[12px]"
                  style={{ color: 'var(--color-graphite)' }}
                >
                  {String(i + 1).padStart(2, '0')}
                </td>
                <td
                  className="px-3 sm:px-5 py-3 font-mono text-xs sm:text-sm whitespace-nowrap"
                  style={{ color: 'var(--color-warm-black)' }}
                  title={s.playerId}
                >
                  {s.playerId}
                </td>
                <td className="px-3 sm:px-5 py-3">
                  <PlayerBadge eliminated={eliminated.has(s.playerId)} />
                </td>
                <td
                  className="hidden sm:table-cell px-5 py-3 text-right font-mono text-xs"
                  style={{ color: 'var(--color-graphite)' }}
                >
                  {s.gamesPlayed}
                </td>
                <td className="px-3 sm:px-5 pr-4 sm:pr-6 py-3 text-right whitespace-nowrap">
                  <Amount value={groupInt(s.cumulativeDelta)} signed />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function PolicyGrid({ state }: { state: TournamentState }) {
  return (
    <section className="space-y-4">
      <SectionEyebrow num="02" label="Policy" />
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <PolicyCard label="Base entry" value={groupInt(state.policy.baseEntryCost)} />
        <PolicyCard
          label="Carry"
          value={bpsToPercent(state.policy.carryBps)}
          hint={`${state.policy.carryBps} bps`}
        />
        <PolicyCard
          label="Slash"
          value={bpsToPercent(state.policy.slashBps)}
          hint={`${state.policy.slashBps} bps`}
        />
        <PolicyCard label="Treasury carry" value={groupInt(state.treasuryCarry)} />
      </div>
    </section>
  );
}

function EconomicsPanel({ economics }: { economics: Economics | null }) {
  return (
    <section className="space-y-4">
      <SectionEyebrow num="03" label="Current economics" />
      {economics === null ? (
        <StateBlock>
          <MonoNote>No active game economics</MonoNote>
        </StateBlock>
      ) : (
        <div className="parchment-strong p-5 sm:p-6">
          <EconRow label="Entry cost" value={groupInt(economics.entryCost)} />
          <EconRow label="Base pot" value={groupInt(economics.basePot)} />
          <EconRow label="Incoming carry" value={groupInt(economics.incomingCarry)} />
          <EconRow label="Released carry" value={groupInt(economics.releasedCarry)} />
          <EconRow label="Carry" value={groupInt(economics.carry)} signed />
          <EconRow label="Carry remainder" value={groupInt(economics.carryRemainder)} />
          <EconRow label="Slash" value={groupInt(economics.slash)} signed />
          <EconRow label="Treasury Δ" value={groupInt(economics.treasuryDelta)} signed />
        </div>
      )}
    </section>
  );
}

function ReceiptCard({ receipt }: { receipt: Settlement | null }) {
  return (
    <section className="space-y-4">
      <SectionEyebrow num="04" label="Last settlement receipt" />
      {receipt === null ? (
        <StateBlock>
          <MonoNote>No settlement yet</MonoNote>
        </StateBlock>
      ) : (
        <div className="parchment p-5 sm:p-6 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span
              className="font-mono text-[10px] tracking-[0.18em] uppercase"
              style={{ color: 'var(--color-graphite)' }}
            >
              Transaction
            </span>
            <CopyHash hash={receipt.txHash} />
          </div>
          <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-3">
            <ReceiptField label="Block" value={String(receipt.blockNumber)} />
            <ReceiptField label="Game index" value={String(receipt.gameIndex)} />
            <ReceiptField label="Game" value={receipt.gameId} mono />
            <ReceiptField label="Entry cost" value={groupInt(receipt.entryCost)} />
            <ReceiptField label="Carry" value={groupInt(receipt.carry)} signed />
            <ReceiptField label="Slash" value={groupInt(receipt.slash)} signed />
            <ReceiptField label="Treasury Δ" value={groupInt(receipt.treasuryDelta)} signed />
          </dl>
        </div>
      )}
    </section>
  );
}

function ReceiptField({
  label,
  value,
  signed = false,
  mono = false,
}: {
  label: string;
  value: string;
  signed?: boolean;
  mono?: boolean;
}) {
  return (
    <div>
      <dt
        className="font-mono text-[10px] tracking-[0.18em] uppercase"
        style={{ color: 'var(--color-graphite)' }}
      >
        {label}
      </dt>
      <dd className="mt-1 text-sm">
        {signed ? (
          <Amount value={value} signed />
        ) : (
          <span
            className={mono ? 'font-mono text-xs tabular-nums' : 'font-mono tabular-nums'}
            style={{ color: 'var(--color-warm-black)' }}
          >
            {value}
          </span>
        )}
      </dd>
    </div>
  );
}

export default function TournamentPage() {
  const { id = '' } = useParams<{ id: string }>();
  const phase = useTournamentState(id);

  if (phase.kind === 'loading') {
    return (
      <main className="space-y-6">
        <StateBlock>
          <MonoNote>Loading tournament…</MonoNote>
        </StateBlock>
      </main>
    );
  }

  if (phase.kind === 'error') {
    return (
      <main className="space-y-6">
        <StateBlock>
          <MonoNote>Could not load tournament</MonoNote>
          <p
            className="font-editorial italic text-sm mt-3"
            style={{ color: 'var(--color-graphite)' }}
          >
            {phase.message}
          </p>
        </StateBlock>
      </main>
    );
  }

  const { state } = phase;
  return (
    <main className="space-y-8">
      <Header state={state} />
      <StandingsTable state={state} />
      <PolicyGrid state={state} />
      <EconomicsPanel economics={state.currentEconomics} />
      <ReceiptCard receipt={state.lastSettlement} />
    </main>
  );
}
