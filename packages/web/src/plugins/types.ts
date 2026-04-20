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
  // biome-ignore lint/suspicious/noExplicitAny: wire payload is per-plugin; narrow at the consumer
  data?: any;
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
 * Common props every slot receives. Kept liberal on purpose — start with the
 * obvious context (active lobby/game) and expand as Phase 5/6 wires real
 * plugins. Slot components should treat all fields as optional; the host
 * does not guarantee any particular field is set in every shell.
 */
export interface SlotProps {
  /** Active game/lobby context (if any). */
  game?: { id: string; name: string };
  lobbyId?: string;
  gameId?: string;
  /**
   * Raw relay envelopes visible to the caller (lobby state `.relay`, or the
   * game's `relayMessages`). Slot plugins filter by `type` to pick their
   * traffic. Empty array when the host has no relay payload to forward.
   */
  relayMessages?: RelayMessageView[];
  /**
   * Roster of agents (lobby participants or game players). Used by slots
   * that render `handle` alongside sender IDs.
   */
  agents?: SlotAgent[];
}

export interface WebToolPlugin {
  id: string;
  slots: Partial<Record<SlotName, React.FC<SlotProps>>>;
}
