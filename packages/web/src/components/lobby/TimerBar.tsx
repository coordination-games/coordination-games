export default function TimerBar({
  timeRemaining,
  noTimeout,
  phase,
  onPauseTimer,
  onCloseLobby,
}: {
  timeRemaining: number | null;
  noTimeout: boolean;
  phase: string;
  onPauseTimer: () => void;
  onCloseLobby: () => void;
}) {
  return (
    <div className="rounded-lg parchment-strong p-3 flex items-center justify-between">
      <div className="flex items-center gap-3">
        <span className="font-heading text-2xl font-bold tabular-nums" style={{ color: noTimeout ? 'var(--color-ink-faint)' : (timeRemaining !== null && timeRemaining < 30 ? 'var(--color-blood)' : 'var(--color-amber)') }}>
          {noTimeout ? '--:--' : timeRemaining !== null ? `${Math.floor(timeRemaining / 60)}:${String(timeRemaining % 60).padStart(2, '0')}` : '--:--'}
        </span>
        <span className="text-xs" style={{ color: 'var(--color-ink-faint)' }}>
          {noTimeout ? 'No time limit' : phase === 'pre_game' ? 'to pick classes' : 'until lobby closes'}
        </span>
        <button onClick={onPauseTimer} disabled={noTimeout}
          className="cursor-pointer font-heading rounded px-3 py-1 text-xs font-medium transition-all active:scale-95 disabled:cursor-default"
          style={{
            background: noTimeout ? 'rgba(184, 134, 11, 0.1)' : 'transparent',
            color: noTimeout ? 'var(--color-amber)' : 'var(--color-ink-light)',
            border: `1px solid ${noTimeout ? 'rgba(184, 134, 11, 0.3)' : 'rgba(42, 31, 14, 0.15)'}`,
          }}>
          {noTimeout ? 'Paused' : 'Pause timer'}
        </button>
      </div>
      <button onClick={onCloseLobby}
        className="cursor-pointer font-heading rounded px-3 py-1 text-xs font-medium transition-all active:scale-95"
        style={{ background: 'transparent', color: 'var(--color-blood)', border: '1px solid rgba(139, 32, 32, 0.2)' }}>
        Close Lobby
      </button>
    </div>
  );
}
