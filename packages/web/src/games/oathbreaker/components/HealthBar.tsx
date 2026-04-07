// Retro health bar centered on the $1 break-even line

interface HealthBarProps {
  dollarValue: number;
  breakEvenDelta: number;
  width?: number | string;
}

function formatDollar(v: number): string {
  if (v >= 0) return `+$${v.toFixed(2)}`;
  return `-$${Math.abs(v).toFixed(2)}`;
}

export function HealthBar({ dollarValue, breakEvenDelta, width = '100%' }: HealthBarProps) {
  const maxDelta = 1.0;
  const clampedDelta = Math.max(-maxDelta, Math.min(maxDelta, breakEvenDelta));
  const pct = ((clampedDelta / maxDelta) * 50) + 50;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, width }}>
      <span className="pixel-text" style={{
        fontSize: 8,
        color: '#9ca3af',
        width: 52,
        textAlign: 'right',
        flexShrink: 0,
      }}>
        ${dollarValue.toFixed(2)}
      </span>
      <div className="retro-health-bar" style={{ flex: 1 }}>
        <div className="center-line" />
        {breakEvenDelta >= 0 ? (
          <div className="fill" style={{
            left: '50%',
            width: `${pct - 50}%`,
            background: 'linear-gradient(90deg, #3b82f6, #eab308)',
            borderRadius: '0 2px 2px 0',
          }} />
        ) : (
          <div className="fill" style={{
            right: '50%',
            width: `${50 - pct}%`,
            background: '#ef4444',
            borderRadius: '2px 0 0 2px',
          }} />
        )}
      </div>
      <span className="pixel-text" style={{
        fontSize: 7,
        color: breakEvenDelta >= 0 ? '#4ade80' : '#f87171',
        width: 52,
        flexShrink: 0,
      }}>
        {formatDollar(breakEvenDelta)}
      </span>
    </div>
  );
}
