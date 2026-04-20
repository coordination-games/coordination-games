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
}

export interface WebToolPlugin {
  id: string;
  slots: Partial<Record<SlotName, React.FC<SlotProps>>>;
}
