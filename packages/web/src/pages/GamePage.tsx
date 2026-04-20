import { useParams } from 'react-router-dom';
import { getDefaultPlugin, getSpectatorPlugin } from '../games/registry';
import { useSpectatorStream } from '../hooks/useSpectatorStream';
import { type RelayMessageView, SlotHost } from '../plugins';

// ---------------------------------------------------------------------------
// GamePage — game-agnostic wrapper that delegates to a SpectatorPlugin.
//
// Phase 7.1: the WS lifecycle now lives in `useSpectatorStream`. This page
// reads the unified spectator payload and forwards (handles, relay) to the
// slot host + the per-game SpectatorView. The chat-extraction WS that used
// to live here is gone — Phase 7.2 will drop the now-redundant <SlotHost>
// chat panel (chat envelopes are part of the unified payload).
// ---------------------------------------------------------------------------

export default function GamePage() {
  const { id } = useParams<{ id: string }>();
  const { snapshot } = useSpectatorStream(id ?? '');

  const defaultGameType = getDefaultPlugin().gameType;
  const gameType =
    snapshot?.meta.gameType && snapshot.meta.gameType !== '__unknown__'
      ? snapshot.meta.gameType
      : defaultGameType;
  const handles = snapshot?.meta.handles ?? {};
  // SlotHost expects `RelayMessageView[]` (mirrors RelayEnvelope at the
  // engine boundary). Spectator-pending payloads have no `relay` field —
  // surface an empty list while the delay window has not yet elapsed.
  const relayMessages: RelayMessageView[] =
    snapshot?.type === 'state_update' ? (snapshot.relay as RelayMessageView[]) : [];

  if (!snapshot) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-5rem)]">
        <div className="text-center">
          <p className="text-gray-400">Loading game...</p>
        </div>
      </div>
    );
  }

  const plugin = getSpectatorPlugin(gameType);

  if (!plugin) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-5rem)]">
        <div className="text-center">
          <p className="text-gray-400">Unknown game type: {gameType}</p>
        </div>
      </div>
    );
  }

  const SpectatorView = plugin.SpectatorView;
  // Build a synthetic agents array from `handles` so plugin slots can render
  // friendly names. The game payload doesn't carry a roster object, so we
  // derive one from the same map the spectator view uses.
  const agents = Object.entries(handles).map(([id, handle]) => ({ id, handle }));

  return (
    <>
      <SlotHost name="game:panel" gameId={id ?? ''} relayMessages={relayMessages} agents={agents} />
      <SpectatorView
        gameState={null}
        chatMessages={[]}
        handles={handles}
        gameId={id ?? ''}
        gameType={gameType}
        phase={snapshot.meta.finished ? 'finished' : 'in_progress'}
      />
    </>
  );
}
