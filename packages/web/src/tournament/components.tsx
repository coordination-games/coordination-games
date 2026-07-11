import { useState } from 'react';
import { type Sign, shortenHash, signOf } from './format.js';
import type { TournamentStatus } from './parse.js';

/** Section header: two-digit number + label + hairline divider (games.coop idiom). */
export function SectionEyebrow({ num, label }: { num: string; label: string }) {
  return (
    <h2 className="flex items-center gap-3 m-0">
      <span
        aria-hidden="true"
        className="font-mono text-[11px] tracking-[0.22em] uppercase"
        style={{ color: 'var(--color-graphite)' }}
      >
        {num}
      </span>
      <span
        className="font-mono text-[11px] tracking-[0.22em] uppercase"
        style={{ color: 'var(--color-warm-black)' }}
      >
        {label}
      </span>
      <div className="flex-1 hairline" />
    </h2>
  );
}

function signColor(sign: Sign): string {
  if (sign === 'negative') return 'var(--color-hot-deep)';
  if (sign === 'positive') return 'var(--color-mint-text)';
  return 'var(--color-graphite)';
}

/** Colored numeric value; tints by sign when `signed` is set. */
export function Amount({ value, signed = false }: { value: string; signed?: boolean }) {
  const color = signed ? signColor(signOf(value)) : 'var(--color-warm-black)';
  return (
    <span className="font-mono tabular-nums" style={{ color }}>
      {value}
    </span>
  );
}

const STATUS_STYLE: Record<TournamentStatus, { bg: string; fg: string; label: string }> = {
  running: { bg: 'var(--color-mint)', fg: 'var(--color-warm-black)', label: 'Running' },
  completed: { bg: 'var(--color-warm-black)', fg: 'var(--color-bone)', label: 'Completed' },
  failed: { bg: 'var(--color-hot-deep)', fg: 'var(--color-bone)', label: 'Failed' },
};

export function StatusBadge({ status }: { status: TournamentStatus }) {
  const s = STATUS_STYLE[status];
  return (
    <span
      className="inline-flex items-center font-mono text-[10px] tracking-[0.18em] uppercase px-2.5 py-1"
      style={{ background: s.bg, color: s.fg }}
    >
      <span className="sr-only">Tournament status: </span>
      {s.label}
    </span>
  );
}

/** Active / eliminated pill for a standings row. Text carries the meaning, not color alone. */
export function PlayerBadge({ eliminated }: { eliminated: boolean }) {
  const color = eliminated ? 'var(--color-hot-deep)' : 'var(--color-mint-text)';
  return (
    <span
      className="inline-flex items-center gap-1.5 font-mono text-[10px] tracking-[0.16em] uppercase"
      style={{ color }}
    >
      <span
        aria-hidden="true"
        className="inline-block w-1.5 h-1.5 rounded-full"
        style={{ background: color }}
      />
      {eliminated ? 'Eliminated' : 'Active'}
    </span>
  );
}

/** Label + value tile for the policy grid. */
export function PolicyCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="parchment p-5">
      <div
        className="font-mono text-[10px] tracking-[0.2em] uppercase"
        style={{ color: 'var(--color-graphite)' }}
      >
        {label}
      </div>
      <div
        className="font-display text-2xl font-medium mt-2 tabular-nums"
        style={{ color: 'var(--color-warm-black)' }}
      >
        {value}
      </div>
      {hint ? (
        <div
          className="font-mono text-[10px] tracking-[0.12em] mt-1"
          style={{ color: 'var(--color-graphite)' }}
        >
          {hint}
        </div>
      ) : null}
    </div>
  );
}

/** Label/value row for the economics panel. */
export function EconRow({
  label,
  value,
  signed = false,
}: {
  label: string;
  value: string;
  signed?: boolean;
}) {
  return (
    <div
      className="flex justify-between items-center py-2.5 gap-4"
      style={{ borderBottom: '1px solid rgba(28,26,23,0.06)' }}
    >
      <span className="text-sm" style={{ color: 'var(--color-graphite)' }}>
        {label}
      </span>
      <Amount value={value} signed={signed} />
    </div>
  );
}

/** Shortened hash (tx or game id) with a copy button that copies the full value. */
export function CopyHash({ hash, label = 'transaction hash' }: { hash: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="focus-ring inline-flex items-center gap-2 font-mono text-xs px-2.5 py-1.5 transition-colors"
      style={{
        background: 'var(--color-bone)',
        border: '1px solid rgba(28,26,23,0.12)',
        color: 'var(--color-warm-black)',
      }}
      aria-label={`Copy full ${label} ${hash}`}
      onClick={() => {
        navigator.clipboard?.writeText(hash);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      <span className="tabular-nums">{shortenHash(hash)}</span>
      <span
        className="text-[10px] tracking-[0.14em] uppercase"
        style={{ color: copied ? 'var(--color-mint-text)' : 'var(--color-graphite)' }}
      >
        {copied ? 'Copied' : 'Copy'}
      </span>
    </button>
  );
}
