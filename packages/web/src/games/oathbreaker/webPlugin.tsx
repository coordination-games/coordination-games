/**
 * OATHBREAKER web plugin — fills the `lobby:card` slot for OATHBREAKER
 * lobbies and games. Phase 6.3 colocation: extracted from
 * `LobbiesPage.tsx`'s `gameType === 'oathbreaker'` branches.
 */

import { motion } from 'framer-motion';
import type { SlotProps, WebToolPlugin } from '../../plugins/types';

function phaseBadge(phase: 'in_progress' | 'finished' | 'lobby') {
  switch (phase) {
    case 'in_progress':
      return (
        <span
          className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-heading font-medium tracking-wide"
          style={{
            background: 'rgba(58, 90, 42, 0.1)',
            color: 'var(--color-forest)',
            border: '1px solid rgba(58, 90, 42, 0.2)',
          }}
        >
          <span
            className="h-1.5 w-1.5 rounded-full animate-pulse"
            style={{ background: 'var(--color-forest-light)' }}
          />
          Live
        </span>
      );
    case 'finished':
      return (
        <span
          className="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-heading font-medium tracking-wide"
          style={{
            background: 'rgba(42, 31, 14, 0.06)',
            color: 'var(--color-ink-faint)',
            border: '1px solid rgba(42, 31, 14, 0.1)',
          }}
        >
          Finished
        </span>
      );
    case 'lobby':
      return (
        <span
          className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-heading font-medium tracking-wide"
          style={{
            background: 'rgba(184, 134, 11, 0.08)',
            color: 'var(--color-amber)',
            border: '1px solid rgba(184, 134, 11, 0.2)',
          }}
        >
          <span
            className="h-1.5 w-1.5 rounded-full animate-pulse"
            style={{ background: 'var(--color-amber)' }}
          />
          Forming
        </span>
      );
  }
}

function OathLobbyCard({
  lobby,
  onClick,
}: {
  lobby: NonNullable<SlotProps['lobby']>;
  onClick?: (() => void) | undefined;
}) {
  const playerCount = lobby.playerCount ?? 0;
  const teamSize = lobby.teamSize;
  // OATH `teamSize` carries the player count target (no 2x multiplier).
  const capacity = teamSize ?? undefined;
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
        <span className="font-semibold" style={{ color: 'var(--color-amber)' }}>
          {playerCount}
        </span>
        {capacity != null ? <span>/{capacity}</span> : null} players
      </div>
      <div className="flex items-center justify-end">
        <span className="font-heading text-xs font-medium" style={{ color: 'var(--color-blood)' }}>
          OATHBREAKER
        </span>
      </div>
    </button>
  );
}

function OathGameCard({
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
              background: isLive
                ? 'linear-gradient(90deg, var(--color-blood), #c55)'
                : 'linear-gradient(90deg, var(--color-ink-faint), var(--color-wood-light))',
            }}
            initial={{ width: 0 }}
            animate={{ width: `${progress}%` }}
            transition={{ duration: 0.8, ease: 'easeOut' }}
          />
        </div>
      </div>
      <div className="flex items-center justify-between text-sm">
        <span className="font-heading text-xs font-medium" style={{ color: 'var(--color-blood)' }}>
          OATHBREAKER
        </span>
        <span className="font-mono text-xs" style={{ color: 'var(--color-ink-faint)' }}>
          {game.playerCount ?? '?'} players
        </span>
      </div>
    </button>
  );
}

function OathLobbyCardSlot(props: SlotProps) {
  if (props.lobby) return <OathLobbyCard lobby={props.lobby} onClick={props.onClick} />;
  if (props.gameSummary) return <OathGameCard game={props.gameSummary} onClick={props.onClick} />;
  return null;
}

export const OathbreakerWebPlugin: WebToolPlugin = {
  id: 'oathbreaker:web',
  gameType: 'oathbreaker',
  slots: {
    'lobby:card': OathLobbyCardSlot,
  },
};
