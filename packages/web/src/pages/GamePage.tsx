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

interface RationaleMessage {
  from: string;
  message: string;
  timestamp: number;
  turn: number;
  scope: string;
  stage?: string;
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
        from: msg.from ?? msg.data?.from ?? 'unknown',
        message: msg.data.body,
        timestamp: msg.timestamp ?? 0,
      });
    }
  }
  return msgs;
}

function extractRationale(data: any): RationaleMessage[] {
  const relay = data?.relayMessages;
  if (!Array.isArray(relay)) return [];
  const msgs: RationaleMessage[] = [];
  for (const msg of relay) {
    if (msg.type === 'rationale' && msg.data?.body) {
      msgs.push({
        from: msg.sender ?? msg.from ?? 'unknown',
        message: msg.data.body,
        timestamp: msg.timestamp ?? 0,
        turn: msg.turn ?? 0,
        scope: msg.scope ?? 'all',
        stage: msg.data.stage,
      });
    }
  }
  return msgs;
}

function RationaleOverlay({ messages, handles }: { messages: RationaleMessage[]; handles: Record<string, string> }) {
  if (messages.length === 0) return null;

  return (
    <div className="pointer-events-auto absolute right-3 top-3 z-30 w-80 max-w-[calc(100vw-2rem)] rounded-lg border border-violet-500/20 bg-slate-950/92 p-3 shadow-2xl backdrop-blur-sm">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-violet-300">Rationale Surface</h3>
        <span className="text-[10px] uppercase tracking-wider text-slate-400">explicit, not hidden CoT</span>
      </div>
      <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
        {[...messages].slice(-8).reverse().map((msg, idx) => {
          const name = handles[msg.from] ?? msg.from;
          return (
            <div key={`${msg.from}-${msg.turn}-${msg.timestamp}-${idx}`} className="rounded border border-slate-800 bg-slate-900/80 p-2 text-xs">
              <div className="mb-1 flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-wider text-slate-400">
                <span className="font-semibold text-violet-300">{name}</span>
                <span>turn {msg.turn}</span>
                <span>{msg.scope}</span>
                {msg.stage ? <span>{msg.stage}</span> : null}
              </div>
              <div className="leading-5 text-slate-200">{msg.message}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
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
  const [rationaleMessages, setRationaleMessages] = useState<RationaleMessage[]>([]);
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
        const r = extractRationale(data);
        if (r.length) setRationaleMessages(r);
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
        const r = extractRationale(data);
        if (r.length) setRationaleMessages(r);
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
    <div className="relative">
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
      <RationaleOverlay messages={rationaleMessages} handles={handles} />
    </div>
  );
}
