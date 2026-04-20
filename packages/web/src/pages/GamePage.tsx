import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { API_BASE, getWsUrl } from '../config.js';
import { getSpectatorPlugin } from '../games/registry';
import { type RelayMessageView, SlotHost } from '../plugins';

// ---------------------------------------------------------------------------
// Helpers — extract platform data (handles, raw relay) from server payloads
// ---------------------------------------------------------------------------

// Phase 5.1: this page no longer extracts chat. Chat lives in a
// `WebToolPlugin` rendered by `<SlotHost name="game:panel">`. The page
// just keeps the raw relay slice from the most recent payload and forwards
// it to the slot host. The current SpectatorView still wants `chatMessages`
// because Phase 6 owns the broader spectator-API refactor — for now we
// pass an empty array and let the slot host render chat above the view.

// biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
function extractHandles(data: any): Record<string, string> {
  return data?.handles ?? {};
}

// biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
function extractRelay(data: any): RelayMessageView[] {
  const relay = data?.relayMessages;
  return Array.isArray(relay) ? (relay as RelayMessageView[]) : [];
}

// ---------------------------------------------------------------------------
// GamePage — game-agnostic wrapper that delegates to a SpectatorPlugin
// ---------------------------------------------------------------------------

export default function GamePage() {
  const { id } = useParams<{ id: string }>();
  const [perspective, setPerspective] = useState<'all' | 'A' | 'B'>('all');
  const [gameType, setGameType] = useState<string | null>(null);
  const [handles, setHandles] = useState<Record<string, string>>({});
  const [relayMessages, setRelayMessages] = useState<RelayMessageView[]>([]);
  const [loading, setLoading] = useState(true);
  const wsRef = useRef<WebSocket | null>(null);

  // Fetch game type + platform data, connect WS
  useEffect(() => {
    if (!id) return;

    fetch(`${API_BASE}/games/${id}`)
      .then((r) => r.json())
      .then((data) => {
        setGameType(data.gameType ?? 'capture-the-lobster');
        const h = extractHandles(data);
        if (Object.keys(h).length) setHandles(h);
        const r = extractRelay(data);
        if (r.length) setRelayMessages(r);
        setLoading(false);
      })
      .catch(() => {
        setGameType('capture-the-lobster');
        setLoading(false);
      });

    // Connect WebSocket for live updates
    const wsUrl = getWsUrl(`/ws/game/${id}`);
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onmessage = (event) => {
      try {
        const raw = JSON.parse(event.data);
        const data = raw.data ?? raw;
        const h = extractHandles(data);
        if (Object.keys(h).length) setHandles(h);
        const r = extractRelay(data);
        if (r.length) setRelayMessages(r);
      } catch {}
    };

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [id]);

  if (loading || !gameType) {
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
        phase="in_progress"
        perspective={perspective}
        onPerspectiveChange={setPerspective}
      />
    </>
  );
}
