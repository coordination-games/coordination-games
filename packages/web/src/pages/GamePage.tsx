import { useState, useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { getSpectatorPlugin } from '../games/registry';

// ---------------------------------------------------------------------------
// Helpers — extract platform data (handles, chat) from server payloads
// ---------------------------------------------------------------------------

interface ChatMessage {
  from: string;
  message: string;
  timestamp: number;
}

function extractHandles(data: any): Record<string, string> {
  return data?.handles ?? {};
}

function extractChat(data: any): ChatMessage[] {
  const relay = data?.relayMessages;
  if (!Array.isArray(relay)) return [];
  const msgs: ChatMessage[] = [];
  for (const msg of relay) {
    if (msg.type === 'messaging' && msg.data?.body) {
      msgs.push({
        from: msg.sender ?? msg.from ?? msg.data?.from ?? 'unknown',
        message: msg.data.body,
        timestamp: msg.timestamp ?? 0,
      });
    }
  }
  return msgs;
}

// ---------------------------------------------------------------------------
// GamePage — game-agnostic wrapper that delegates to a SpectatorPlugin
// ---------------------------------------------------------------------------

export default function GamePage() {
  const { id } = useParams<{ id: string }>();
  const [perspective, setPerspective] = useState<'all' | 'A' | 'B'>('all');
  const [gameType, setGameType] = useState<string | null>(null);
  const [handles, setHandles] = useState<Record<string, string>>({});
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const wsRef = useRef<WebSocket | null>(null);

  // Fetch game type + platform data, connect WS
  useEffect(() => {
    if (!id) return;

    fetch(`/api/games/${id}`)
      .then(r => r.json())
      .then(data => {
        setGameType(data.gameType ?? 'capture-the-lobster');
        const h = extractHandles(data);
        if (Object.keys(h).length) setHandles(h);
        const c = extractChat(data);
        if (c.length) setChatMessages(c);
        setLoading(false);
      })
      .catch(() => {
        setGameType('capture-the-lobster');
        setLoading(false);
      });

    // Connect WebSocket for live updates
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws/game/${id}`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onmessage = (event) => {
      try {
        const raw = JSON.parse(event.data);
        const data = raw.data ?? raw;
        const h = extractHandles(data);
        if (Object.keys(h).length) setHandles(h);
        const c = extractChat(data);
        if (c.length) setChatMessages(c);
      } catch {}
    };

    return () => { ws.close(); wsRef.current = null; };
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

  return (
    <SpectatorView
      gameState={null}
      chatMessages={chatMessages}
      handles={handles}
      gameId={id ?? ''}
      gameType={gameType}
      phase="in_progress"
      perspective={perspective}
      onPerspectiveChange={setPerspective}
    />
  );
}
