import { useEffect, useRef } from 'react';

interface ChatMessage {
  from: string;
  message: string;
  timestamp: number;
}

interface Agent {
  id: string;
  handle: string;
}

// biome-ignore lint/correctness/noUnusedFunctionParameters: unused param; cleanup followup — TODO(2.3-followup)
function AutoScrollChat({ children, deps }: { children: React.ReactNode; deps: number }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const shouldAutoScroll = useRef(true);

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    shouldAutoScroll.current = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
  };

  useEffect(() => {
    if (shouldAutoScroll.current && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, []);

  return (
    <div ref={containerRef} onScroll={handleScroll} className="overflow-y-auto max-h-64">
      {children}
    </div>
  );
}

export { AutoScrollChat };

export default function ChatPanel({
  messages,
  agents,
}: {
  messages: ChatMessage[];
  agents: Agent[];
}) {
  return (
    <div className="rounded-lg parchment-strong p-4">
      <h3
        className="mb-3 font-heading text-sm font-semibold uppercase tracking-wider"
        style={{ color: 'var(--color-ink-faint)' }}
      >
        Lobby Chat
      </h3>
      <AutoScrollChat deps={messages.length}>
        <div className="flex flex-col gap-1">
          {messages.length === 0 && (
            <p className="text-xs italic" style={{ color: 'var(--color-ink-faint)' }}>
              No messages yet...
            </p>
          )}
          {messages.map((m, i) => {
            const agent = agents.find((a) => a.id === m.from);
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: list is stable; refactor in cleanup followup — TODO(2.3-followup)
              <div key={i} className="text-xs">
                <span className="font-semibold" style={{ color: 'var(--color-amber)' }}>
                  {agent?.handle ?? m.from}:
                </span>{' '}
                <span style={{ color: 'var(--color-ink-light)' }}>{m.message}</span>
              </div>
            );
          })}
        </div>
      </AutoScrollChat>
    </div>
  );
}
