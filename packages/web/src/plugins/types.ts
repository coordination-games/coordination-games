import type React from 'react';

/**
 * Named slots that web shells expose to plugins. Plugins declare which slots
 * they fill; shells render <SlotHost name="..."> at the corresponding location
 * and SlotHost picks every plugin that registered a component for that name.
 *
 * Add a new entry here BEFORE wiring a host into a shell page.
 */
export type SlotName =
  | 'lobby:card' // tile in LobbiesPage
  | 'lobby:panel' // side panel in LobbyPage
  | 'game:panel' // side panel in GamePage
  | 'game:overlay'; // overlay on SpectatorView

/**
 * Minimal shape the chat slot (and future relay-aware slots) expect from
 * whatever payload the shell extracts from the server. Intentionally liberal
 * and duck-typed — the shell may pass the lobby WS state, the game WS
 * state, or anything else with the same shape. Slot components should treat
 * every field as optional and defend accordingly.
 */
export interface RelayMessageView {
  type: string;
  /** Wire payload is per-plugin; narrow at the consumer. */
  data?: unknown;
  sender?: string;
  timestamp?: number;
  scope?: { kind?: string; teamId?: string; recipientHandle?: string };
}

/** Lightweight player roster entry used by slot components for display. */
export interface SlotAgent {
  id: string;
  handle?: string;
}

/**
 * Compact lobby summary passed to `lobby:card` slot components. Mirrors the
 * `/lobbies` endpoint shape — the LobbiesPage shell forwards this verbatim.
 *
 * Optional fields explicitly allow `undefined` so the shell can mirror raw
 * API payloads without conditionally constructing the object — important
 * for tsconfig's `exactOptionalPropertyTypes: true`.
 */
export interface LobbySummaryView {
  lobbyId: string;
  gameType?: string | undefined;
  phase: 'lobby' | 'in_progress' | 'finished';
  teamSize?: number | undefined;
  playerCount?: number | undefined;
  createdAt?: string | undefined;
  gameId?: string | null | undefined;
}

/**
 * Compact game summary passed to `lobby:card` slot components. Mirrors the
 * `/games` endpoint shape (mapped through LobbiesPage's loader).
 */
export interface GameSummaryView {
  id: string;
  gameType?: string | undefined;
  turn: number;
  maxTurns: number;
  phase: 'in_progress' | 'finished';
  winner?: string | undefined;
  teamsA: number;
  teamsB: number;
  // OATHBREAKER fields
  round?: number | undefined;
  maxRounds?: number | undefined;
  playerCount?: number | undefined;
}

/**
 * Common props every slot receives. Kept liberal on purpose — start with the
 * obvious context (active lobby/game) and expand as Phase 5/6 wires real
 * plugins. Slot components should treat all fields as optional; the host
 * does not guarantee any particular field is set in every shell.
 */
export interface SlotProps {
  /** Active game/lobby context (if any). Lightweight identity tag. */
  game?: { id: string; name: string } | undefined;
  lobbyId?: string | undefined;
  gameId?: string | undefined;
  /**
   * Game type discriminator. When set, SlotHost filters out plugins whose
   * declared `gameType` doesn't match (universal plugins with no `gameType`
   * always render). Used by `lobby:card` to dispatch to the right game's
   * branded card.
   */
  gameType?: string | undefined;
  /** Full lobby summary for `lobby:card`. */
  lobby?: LobbySummaryView | undefined;
  /** Full game summary for `lobby:card`. */
  gameSummary?: GameSummaryView | undefined;
  /**
   * Click handler for card-style slots (`lobby:card`). Cards forward this
   * to their root button so navigation lives in the shell.
   */
  onClick?: (() => void) | undefined;
  /**
   * Raw relay envelopes visible to the caller (lobby state `.relay`, or the
   * game's `relayMessages`). Slot plugins filter by `type` to pick their
   * traffic. Empty array when the host has no relay payload to forward.
   */
  relayMessages?: RelayMessageView[] | undefined;
  /**
   * Roster of agents (lobby participants or game players). Used by slots
   * that render `handle` alongside sender IDs.
   */
  agents?: SlotAgent[] | undefined;
}

export interface WebToolPlugin {
  id: string;
  /**
   * If set, SlotHost only renders this plugin when the slot's `gameType`
   * prop matches. Universal plugins (chat) leave this undefined and always
   * render.
   */
  gameType?: string;
  slots: Partial<Record<SlotName, React.FC<SlotProps>>>;
}
