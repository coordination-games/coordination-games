/**
 * KibitzerWebPlugin — `WebToolPlugin` shape for the kibitzer overlay.
 *
 * Mirrors the shape declared in `packages/web/src/plugins/types.ts` BUT
 * does NOT import that type — depending back on the web package would
 * invert the dependency direction (the plugin should not know about its
 * host shell). Instead the plugin exports its own structurally-compatible
 * shape and the host wires it via `registerWebPlugin(KibitzerWebPlugin)`.
 *
 * Slot: `game:overlay`. The shell renders this on top of the spectator
 * view; the kibitzer overlay anchors itself bottom-right and stays
 * passive (`pointerEvents: 'none'`) so the underlying game UI is fully
 * interactive.
 *
 * Universal — no `gameType` filter — kibitzer commentary works for every
 * game that publishes chat envelopes. (If a game wanted to opt out, the
 * cleanest path is per-game, not per-plugin: don't enable basic-chat in
 * that game's lobby phases.)
 */

import type React from 'react';
import { CommentaryFeed } from './CommentaryFeed.js';

/**
 * Minimal envelope shape mirroring the web shell's `RelayMessageView`.
 * Kept local so this package doesn't import from `packages/web` types.
 */
interface KibitzerRelayMessageView {
  type: string;
  // biome-ignore lint/suspicious/noExplicitAny: per-plugin payload shape
  data?: any;
  sender?: string;
  timestamp?: number;
}

/**
 * Structural mirror of `packages/web/src/plugins/types.ts#WebToolPlugin`.
 * Kept local so this package doesn't import from `packages/web`. The host's
 * `SlotProps` carries more fields (lobbyId, gameId, game, agents, …) but
 * we only need relayMessages — TypeScript's structural compatibility lets
 * the host's wider props flow into this narrower component signature.
 *
 * NOTE on the array variance gap: the host types `relayMessages` as a
 * mutable `RelayMessageView[]`. We use the same mutability here so the
 * plugin assigns into `WebToolPlugin` cleanly. This is a real coupling
 * point — see `wiki/development/adding-a-plugin.md` for the gap.
 */
export interface KibitzerWebPluginShape {
  id: string;
  slots: {
    'game:overlay': React.FC<{
      relayMessages?: KibitzerRelayMessageView[] | undefined;
    }>;
  };
}

export const KibitzerWebPlugin: KibitzerWebPluginShape = {
  id: 'kibitzer',
  slots: {
    'game:overlay': CommentaryFeed,
  },
};

export { CommentaryFeed, selectCommentary } from './CommentaryFeed.js';
