import { useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import { formatAgentName } from '../lib/format';
import { useGameStore } from '../store';

const MAX_VISIBLE_MESSAGES = 100;
const NEAR_BOTTOM_THRESHOLD = 50;

function isNearBottom(element: HTMLDivElement) {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= NEAR_BOTTOM_THRESHOLD;
}

export function ChatFeed() {
  const messages = useGameStore((state) => state.messages);
  const agents = useGameStore((state) => state.gameState.agents);
  const pendingAgentInfo = useGameStore((state) => state.gameState.pendingAgentInfo);
  const feedRef = useRef<HTMLDivElement>(null);
  const scrollSnapshotRef = useRef({
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    wasNearBottom: true,
    visibleMessageIds: [] as string[],
  });
  const messageHeightsRef = useRef<Record<string, number>>({});

  const visibleMessages = useMemo(
    () =>
      messages.length > MAX_VISIBLE_MESSAGES ? messages.slice(-MAX_VISIBLE_MESSAGES) : messages,
    [messages],
  );
  const visibleMessageIds = useMemo(
    () => visibleMessages.map((message) => message.id),
    [visibleMessages],
  );

  const syncMessageHeights = useCallback((feed: HTMLDivElement) => {
    const nextHeights = { ...messageHeightsRef.current };
    const messageNodes = feed.querySelectorAll<HTMLElement>('[data-message-id]');

    messageNodes.forEach((node) => {
      const { messageId } = node.dataset;
      if (messageId) {
        nextHeights[messageId] = node.getBoundingClientRect().height;
      }
    });

    messageHeightsRef.current = nextHeights;
  }, []);

  const syncScrollSnapshot = useCallback(
    (feed: HTMLDivElement) => {
      scrollSnapshotRef.current = {
        scrollTop: feed.scrollTop,
        scrollHeight: feed.scrollHeight,
        clientHeight: feed.clientHeight,
        wasNearBottom: isNearBottom(feed),
        visibleMessageIds,
      };
    },
    [visibleMessageIds],
  );

  useLayoutEffect(() => {
    const feed = feedRef.current;
    if (!feed) return;

    const previousSnapshot = scrollSnapshotRef.current;

    if (visibleMessageIds.length === 0) {
      feed.scrollTop = 0;
    } else if (previousSnapshot.wasNearBottom) {
      feed.scrollTop = feed.scrollHeight;
    } else {
      const visibleIdSet = new Set(visibleMessageIds);
      const removedIds = previousSnapshot.visibleMessageIds.filter((id) => !visibleIdSet.has(id));

      if (removedIds.length > 0) {
        const removedContentHeight = removedIds.reduce(
          (total, id) => total + (messageHeightsRef.current[id] ?? 0),
          0,
        );
        const gap = Number.parseFloat(
          getComputedStyle(feed).rowGap || getComputedStyle(feed).gap || '0',
        );
        const removedGapHeight = visibleMessageIds.length > 0 ? gap * removedIds.length : 0;
        feed.scrollTop = Math.max(
          0,
          previousSnapshot.scrollTop - removedContentHeight - removedGapHeight,
        );
      }
    }

    syncMessageHeights(feed);
    syncScrollSnapshot(feed);
  }, [syncMessageHeights, syncScrollSnapshot, visibleMessageIds]);

  function handleScroll() {
    const feed = feedRef.current;
    if (!feed) return;

    syncScrollSnapshot(feed);
  }

  const context = { agents, pendingAgentInfo };

  return (
    <section className="border border-[var(--color-line)] rounded-[var(--radius-xl)] overflow-hidden bg-gradient-to-b from-[rgba(12,24,36,0.92)] to-[rgba(8,16,24,0.86)] shadow-[var(--shadow)] backdrop-blur-[16px] min-h-0 flex flex-col h-full">
      <div className="flex justify-between items-start gap-5 p-6 px-7 border-b border-[var(--color-line)] bg-gradient-to-b from-[rgba(24,40,56,0.86)] to-[rgba(10,18,28,0.48)] shrink-0">
        <div>
          <div className="font-mono text-[10px] tracking-[0.24em] uppercase text-[var(--color-text-soft)] pl-1">
            Logged Dialogue
          </div>
          <h2 className="mt-1 font-serif text-xl font-semibold text-[var(--color-text)]">
            Negotiation Wire
          </h2>
        </div>
      </div>

      <div
        ref={feedRef}
        onScroll={handleScroll}
        className="p-6 flex flex-col gap-5 overflow-y-auto custom-scrollbar flex-1"
      >
        {visibleMessages.length === 0 ? (
          <div className="p-4 border border-dashed border-[rgba(233,220,190,0.12)] rounded-[18px] text-center text-[13px] leading-[1.5] text-[var(--color-text-muted)] bg-[rgba(10,20,30,0.36)]">
            No messages yet.
          </div>
        ) : (
          visibleMessages.map((msg) => {
            const isPrivate = msg.type === 'private';
            const isDiary = msg.type === 'diary';

            return (
              <div
                key={msg.id}
                data-message-id={msg.id}
                className="p-5 rounded-[16px] border border-[rgba(233,220,190,0.08)] bg-gradient-to-b from-[rgba(14,26,39,0.86)] to-[rgba(8,16,24,0.78)]"
              >
                <div className="flex justify-between gap-2.5 items-start">
                  <div className="flex items-center gap-2">
                    <div
                      className={`inline-flex items-center px-2 py-1.5 rounded-full font-mono text-[10px] tracking-[0.12em] uppercase leading-none border whitespace-nowrap ${
                        isPrivate
                          ? 'text-[#e7b1a8] bg-[rgba(217,113,99,0.16)] border-[rgba(217,113,99,0.22)]'
                          : isDiary
                            ? 'text-[#ead7ac] bg-[rgba(217,178,95,0.16)] border-[rgba(217,178,95,0.22)]'
                            : 'text-[#b4dbe0] bg-[rgba(99,165,167,0.16)] border-[rgba(99,165,167,0.22)]'
                      }`}
                    >
                      {msg.type}
                    </div>
                    <div className="font-serif text-[18px] text-[var(--color-text)] min-w-0 whitespace-nowrap overflow-hidden text-ellipsis">
                      {formatAgentName(msg.sender, context)}
                      {isPrivate &&
                        msg.recipient &&
                        ` → ${formatAgentName(msg.recipient, context)}`}
                    </div>
                  </div>
                  <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-[var(--color-text-soft)] text-right shrink-0">
                    R{msg.round}
                  </div>
                </div>
                <div
                  className={`mt-2.5 text-[13px] leading-[1.52] text-[var(--color-text-muted)] break-words ${isDiary ? 'italic' : ''}`}
                >
                  {msg.content}
                </div>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
