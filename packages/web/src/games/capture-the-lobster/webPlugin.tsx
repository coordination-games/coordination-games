/**
 * CtL web plugin — fills the `lobby:card` slot for Capture the Lobster
 * lobbies and games. Phase 6.3 colocation: the branded card UI used to live
 * in `LobbiesPage.tsx` as a `gameType === 'capture-the-lobster'` branch;
 * moving it here lets the shell stay game-agnostic.
 *
 * Activation is gated by the plugin's `gameType` field — SlotHost filters
 * this plugin out unless the slot's `gameType` prop is `'capture-the-lobster'`.
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

function CtlLobbyCard({
  lobby,
  onClick,
}: {
  lobby: NonNullable<SlotProps['lobby']>;
  onClick?: (() => void) | undefined;
}) {
  const playerCount = lobby.playerCount ?? 0;
  const teamSize = lobby.teamSize;
  const capacity = teamSize != null ? teamSize * 2 : undefined;
  return (
    // biome-ignore lint/a11y/useButtonType: matches sibling LobbiesPage button styling
    <button
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
        {teamSize != null && (
          <span className="ml-2 text-xs" style={{ color: 'var(--color-ink-faint)' }}>
            · {teamSize}v{teamSize}
          </span>
        )}
      </div>
    </button>
  );
}

function CtlGameCard({
  game,
  onClick,
}: {
  game: NonNullable<SlotProps['gameSummary']>;
  onClick?: (() => void) | undefined;
}) {
  const progress = game.maxTurns > 0 ? Math.round((game.turn / game.maxTurns) * 100) : 0;
  const isLive = game.phase === 'in_progress';
  return (
    // biome-ignore lint/a11y/useButtonType: matches sibling LobbiesPage button styling
    <button
      onClick={onClick}
      className="group cursor-pointer w-full rounded-xl parchment-strong p-5 text-left transition-all duration-200 hover:shadow-md"
    >
      <div className="mb-3 flex items-center justify-between">
        <span className="font-mono text-xs" style={{ color: 'var(--color-ink-faint)' }}>
          {game.id}
        </span>
        {phaseBadge(game.phase)}
      </div>
      <div className="mb-3">
        <div
          className="mb-1.5 flex justify-between text-xs font-mono"
          style={{ color: 'var(--color-ink-faint)' }}
        >
          <span>
            Turn {game.turn}/{game.maxTurns}
          </span>
          <span>{progress}%</span>
        </div>
        <div className="h-1.5 w-full rounded-full" style={{ background: 'rgba(42, 31, 14, 0.08)' }}>
          <motion.div
            className="h-1.5 rounded-full"
            style={{
              width: `${progress}%`,
              background: isLive
                ? 'linear-gradient(90deg, var(--color-forest), var(--color-forest-light))'
                : 'linear-gradient(90deg, var(--color-ink-faint), var(--color-wood-light))',
            }}
            initial={{ width: 0 }}
            animate={{ width: `${progress}%` }}
            transition={{ duration: 0.8, ease: 'easeOut' }}
          />
        </div>
      </div>
      <div className="flex items-center justify-between text-sm">
        <div className="flex items-center gap-2">
          <span
            className="inline-block h-2.5 w-2.5 rounded-full"
            style={{ background: '#3a6aaa', boxShadow: '0 0 4px rgba(58, 106, 170, 0.4)' }}
          />
          <span className="font-heading text-xs font-medium" style={{ color: '#3a6aaa' }}>
            Team A
          </span>
          <span className="font-mono text-xs" style={{ color: 'var(--color-ink-faint)' }}>
            {game.teamsA}
          </span>
        </div>
        <span
          className="text-xs font-heading font-medium"
          style={{ color: 'var(--color-ink-faint)' }}
        >
          vs
        </span>
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs" style={{ color: 'var(--color-ink-faint)' }}>
            {game.teamsB}
          </span>
          <span
            className="font-heading text-xs font-medium"
            style={{ color: 'var(--color-blood)' }}
          >
            Team B
          </span>
          <span
            className="inline-block h-2.5 w-2.5 rounded-full"
            style={{
              background: 'var(--color-blood)',
              boxShadow: '0 0 4px rgba(139, 32, 32, 0.4)',
            }}
          />
        </div>
      </div>
      {game.phase === 'finished' && game.winner && (
        <div
          className="mt-3 pt-3 text-center"
          style={{ borderTop: '1px solid rgba(42, 31, 14, 0.1)' }}
        >
          <span
            className="font-heading text-xs font-bold uppercase tracking-wider"
            style={{ color: 'var(--color-amber)' }}
          >
            Winner: Team {game.winner}
          </span>
        </div>
      )}
    </button>
  );
}

function CtlLobbyCardSlot(props: SlotProps) {
  if (props.lobby) return <CtlLobbyCard lobby={props.lobby} onClick={props.onClick} />;
  if (props.gameSummary) return <CtlGameCard game={props.gameSummary} onClick={props.onClick} />;
  return null;
}

export const CaptureTheLobsterWebPlugin: WebToolPlugin = {
  id: 'capture-the-lobster:web',
  gameType: 'capture-the-lobster',
  slots: {
    'lobby:card': CtlLobbyCardSlot,
  },
};
