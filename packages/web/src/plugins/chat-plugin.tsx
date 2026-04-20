/**
 * ChatSlotPlugin — frontend half of basic-chat (Phase 5.1).
 *
 * Renders the chat panel into the `lobby:panel` and `game:panel` slots.
 * Filters the host's `relayMessages` by `CHAT_RELAY_TYPE` (imported from
 * the chat plugin package — no magic string lives in this file) and hands
 * the result to the existing presentational `ChatPanel` component.
 *
 * The shell (LobbyPage / GamePage) just renders `<SlotHost name="..." />`
 * with the relay payload it already had to extract for state display. If
 * basic-chat is removed from the bundle, this plugin's import breaks and
 * the chat slot disappears — the page renders without it (the tests for
 * the plugin-removal scenario rely on this).
 *
 * Phase 6 colocation: this file is in `packages/web/src/plugins/` rather
 * than alongside basic-chat because basic-chat is a Node/CLI-friendly
 * package today and pulling React into it would force every consumer
 * (workers-server, CLI) to install React. Phase 6.1 will revisit and
 * extract a `@coordination-games/plugin-chat-web` sub-package.
 */

import { CHAT_RELAY_TYPE } from '@coordination-games/plugin-chat';
import ChatPanel from '../components/lobby/ChatPanel';
import type { RelayMessageView, SlotProps, WebToolPlugin } from './types';

interface ChatMessage {
  from: string;
  message: string;
  timestamp: number;
}

function extractChatMessages(relay: RelayMessageView[] | undefined): ChatMessage[] {
  if (!relay?.length) return [];
  const out: ChatMessage[] = [];
  for (const m of relay) {
    if (m.type !== CHAT_RELAY_TYPE) continue;
    const data = m.data as { body?: string; message?: string } | null | undefined;
    const body = data?.body ?? data?.message;
    if (!body) continue;
    out.push({
      from: m.sender ?? 'unknown',
      message: body,
      timestamp: m.timestamp ?? 0,
    });
  }
  return out;
}

function ChatSlotPanel(props: SlotProps) {
  const messages = extractChatMessages(props.relayMessages);
  if (messages.length === 0) return null;
  // ChatPanel expects { id, handle } agents with a non-optional handle.
  const agents = (props.agents ?? []).map((a) => ({ id: a.id, handle: a.handle ?? a.id }));
  return <ChatPanel messages={messages} agents={agents} />;
}

export const ChatSlotPlugin: WebToolPlugin = {
  id: 'basic-chat',
  slots: {
    'lobby:panel': ChatSlotPanel,
    'game:panel': ChatSlotPanel,
  },
};
