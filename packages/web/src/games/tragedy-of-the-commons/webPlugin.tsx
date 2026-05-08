import { motion } from 'framer-motion';
import type { SlotProps, WebToolPlugin } from '../../plugins/types';

function phaseBadge(phase: 'in_progress' | 'finished' | 'lobby') {
  const label = phase === 'lobby' ? 'Forming' : phase === 'in_progress' ? 'Live' : 'Finished';
  const color =
    phase === 'finished'
      ? 'var(--color-ink-faint)'
      : phase === 'lobby'
        ? 'var(--color-amber)'
        : 'var(--color-forest)';
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-heading font-medium tracking-wide"
      style={{
        background: 'rgba(58, 90, 42, 0.08)',
        color,
        border: '1px solid rgba(58, 90, 42, 0.18)',
      }}
    >
      {phase !== 'finished' ? (
        <span className="h-1.5 w-1.5 rounded-full animate-pulse" style={{ background: color }} />
      ) : null}
      {label}
    </span>
  );
}

function TragedyLobbyCard({
  lobby,
  onClick,
}: {
  lobby: NonNullable<SlotProps['lobby']>;
  onClick?: (() => void) | undefined;
}) {
  const playerCount = lobby.playerCount ?? 0;
  const capacity = lobby.teamSize ?? undefined;
  return (
    <button
      type="button"
      onClick={onClick}
      className="group cursor-pointer w-full rounded-xl parchment-strong p-5 text-left transition-all duration-200 hover:shadow-md"
    >
      <div className="mb-3 flex items-center justify-between">
        <span className="font-mono text-xs" style={{ color: 'var(--color-ink-faint)' }}>
          {lobby.lobbyId}
        </span>
        {phaseBadge('lobby')}
      </div>
      <div className="mb-2 text-sm" style={{ color: 'var(--color-ink-light)' }}>
        <span className="font-semibold" style={{ color: 'var(--color-forest)' }}>
          {playerCount}
        </span>
        {capacity != null ? <span>/{capacity}</span> : null} players
      </div>
      <div className="flex items-center justify-end">
        <span className="font-heading text-xs font-medium" style={{ color: 'var(--color-forest)' }}>
          Tragedy of the Commons
        </span>
      </div>
    </button>
  );
}

function TragedyGameCard({
  game,
  onClick,
}: {
  game: NonNullable<SlotProps['gameSummary']>;
  onClick?: (() => void) | undefined;
}) {
  const round = game.round ?? game.turn ?? 0;
  const maxRounds = game.maxRounds ?? game.maxTurns ?? 12;
  const progress = maxRounds > 0 ? Math.round((round / maxRounds) * 100) : 0;
  const isLive = game.phase === 'in_progress';
  return (
    <button
      type="button"
      onClick={onClick}
      className="group cursor-pointer w-full rounded-xl parchment-strong p-5 text-left transition-all duration-200 hover:shadow-md"
    >
      <div className="mb-3 flex items-center justify-between">
        <span className="font-mono text-xs" style={{ color: 'var(--color-ink-faint)' }}>
          {game.id}
        </span>
        {phaseBadge(isLive ? 'in_progress' : 'finished')}
      </div>
      <div className="mb-3">
        <div
          className="mb-1.5 flex justify-between text-xs font-mono"
          style={{ color: 'var(--color-ink-faint)' }}
        >
          <span>
            Round {round}/{maxRounds}
          </span>
          <span>{progress}%</span>
        </div>
        <div className="h-1.5 w-full rounded-full" style={{ background: 'rgba(42, 31, 14, 0.08)' }}>
          <motion.div
            className="h-1.5 rounded-full"
            style={{
              width: `${progress}%`,
              background: 'linear-gradient(90deg, #4ade80, #e9d852, #ef4444)',
            }}
            initial={{ width: 0 }}
            animate={{ width: `${progress}%` }}
            transition={{ duration: 0.8, ease: 'easeOut' }}
          />
        </div>
      </div>
      <div className="flex items-center justify-between text-sm">
        <span className="font-heading text-xs font-medium" style={{ color: 'var(--color-forest)' }}>
          Tragedy of the Commons
        </span>
        <span className="font-mono text-xs" style={{ color: 'var(--color-ink-faint)' }}>
          {game.playerCount ?? '?'} players
        </span>
      </div>
    </button>
  );
}

function TragedyLobbyCardSlot(props: SlotProps) {
  if (props.lobby) return <TragedyLobbyCard lobby={props.lobby} onClick={props.onClick} />;
  if (props.gameSummary)
    return <TragedyGameCard game={props.gameSummary} onClick={props.onClick} />;
  return null;
}

export const TragedyOfTheCommonsWebPlugin: WebToolPlugin = {
  id: 'tragedy-of-the-commons:web',
  gameType: 'tragedy-of-the-commons',
  slots: {
    'lobby:card': TragedyLobbyCardSlot,
  },
};
