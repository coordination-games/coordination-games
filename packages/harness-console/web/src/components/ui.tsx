import { type ReactNode, useState } from 'react';

const STATUS_COLORS: Record<string, string> = {
  running: 'var(--amber)',
  ok: 'var(--mint)',
  done: 'var(--mint)',
  error: 'var(--hot)',
  stopped: 'var(--ink-dim)',
  incomplete: 'var(--amber)',
};

export function StatusPill({ status }: { status: string }) {
  const color = STATUS_COLORS[status] ?? 'var(--ink-dim)';
  return (
    <span
      className="inline-flex items-center gap-1.5 font-mono text-[11px] px-2 py-0.5 rounded-full border"
      style={{ color, borderColor: color }}
    >
      <span
        className="w-1.5 h-1.5 rounded-full"
        style={{
          background: color,
          animation: status === 'running' ? 'pulse 1.2s ease-in-out infinite' : undefined,
        }}
      />
      {status}
    </span>
  );
}

export function Section({
  title,
  children,
  right,
}: {
  title: string;
  children: ReactNode;
  right?: ReactNode;
}) {
  return (
    <section className="panel p-4 mb-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="label">{title}</h2>
        {right}
      </div>
      {children}
    </section>
  );
}

export function JsonBlock({ value, startOpen = false }: { value: unknown; startOpen?: boolean }) {
  const [open, setOpen] = useState(startOpen);
  return (
    <div>
      <button type="button" className="btn" onClick={() => setOpen(!open)}>
        {open ? 'hide json' : 'show json'}
      </button>
      {open && <pre className="terminal mt-2 max-h-96">{JSON.stringify(value, null, 2)}</pre>}
    </div>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="block">
      <div className="label mb-1">{label}</div>
      {children}
    </div>
  );
}

/**
 * Model picker: a real <select> over the known models (datalist is unreliable
 * in Safari) with a "custom…" escape hatch for anything else.
 */
export function ModelSelect({
  value,
  onChange,
  options,
  disabled = false,
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  disabled?: boolean;
}) {
  const isCustom = !options.includes(value);
  return (
    <div className="flex gap-2">
      <select
        className="input"
        disabled={disabled}
        value={isCustom ? '__custom__' : value}
        onChange={(e) => {
          if (e.target.value === '__custom__') onChange('');
          else onChange(e.target.value);
        }}
      >
        {options.map((m) => (
          <option key={m} value={m}>
            {m.replace(/^anthropic\//, '')}
          </option>
        ))}
        <option value="__custom__">custom…</option>
      </select>
      {isCustom && (
        <input
          className="input"
          disabled={disabled}
          value={value}
          placeholder="model id (e.g. openrouter/minimax/minimax-m2)"
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </div>
  );
}

export function ErrorNote({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <div
      className="panel p-3 mb-4 font-mono text-xs"
      style={{ color: 'var(--hot)', borderColor: 'var(--hot)' }}
    >
      {error}
    </div>
  );
}

/** winnerLabel is supposed to be human-readable, but some games emit a raw
 * player UUID — truncate those for display. */
export function fmtWinner(label: string | null | undefined): string {
  if (!label) return '(tie/none)';
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i.test(label) ? `${label.slice(0, 8)}…` : label;
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="py-10 text-center font-mono text-sm" style={{ color: 'var(--ink-dim)' }}>
      {children}
    </div>
  );
}
