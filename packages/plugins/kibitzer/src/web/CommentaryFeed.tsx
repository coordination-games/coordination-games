/**
 * CommentaryFeed — overlay component for the kibitzer plugin (Phase 5.4).
 *
 * Reads `kibitzer:comment` envelopes out of the slot's `relayMessages`
 * payload, dedupes by `seq`, sorts ascending, and renders a small
 * stack of recent commentary lines anchored to the bottom-right of the
 * spectator overlay.
 *
 * Why colocated with the plugin (vs. `packages/web/src/plugins/kibitzer.tsx`):
 * Phase 5.4's mandate is to count files OUTSIDE the plugin package. The
 * basic-chat web piece lives in `packages/web/` precisely because chat
 * predates the colocated convention; kibitzer treats colocation as the
 * default. The plugin ships its own `tsconfig` with `jsx: 'react-jsx'`
 * and `react` declared as a peer dep so non-React consumers (workers-
 * server) don't take on the React payload.
 *
 * Defensive duck-typing: every field is read with optional chaining so a
 * shell that doesn't forward `relayMessages` simply renders nothing —
 * the overlay never throws.
 */

import { useMemo } from 'react';
import { KIBITZER_COMMENT_TYPE } from '../index.js';

/**
 * Minimal envelope shape we care about. Mirrors the web shell's
 * `RelayMessageView` without importing it (the plugin shouldn't depend
 * on `packages/web` types — that direction would invert the dependency).
 */
interface RelayMessageView {
  type: string;
  // biome-ignore lint/suspicious/noExplicitAny: per-plugin payload shape
  data?: any;
  sender?: string;
  timestamp?: number;
}

interface CommentaryItem {
  seq: number;
  text: string;
  timestamp: number;
}

/**
 * Maximum lines kept on screen. Older ones scroll off; we don't garbage-
 * collect from the underlying envelope log (the unified spectator
 * payload is the source of truth).
 */
const MAX_VISIBLE_LINES = 5;

/** Pure: extract + dedupe + sort the commentary stream. Exported for tests. */
export function selectCommentary(relay: RelayMessageView[] | undefined): CommentaryItem[] {
  if (!relay?.length) return [];
  const bySeq = new Map<number, CommentaryItem>();
  for (const env of relay) {
    if (env.type !== KIBITZER_COMMENT_TYPE) continue;
    const data = env.data as { text?: unknown; seq?: unknown } | undefined;
    const seq = typeof data?.seq === 'number' ? data.seq : null;
    const text = typeof data?.text === 'string' ? data.text : null;
    if (seq === null || text === null) continue;
    bySeq.set(seq, {
      seq,
      text,
      timestamp: env.timestamp ?? 0,
    });
  }
  return Array.from(bySeq.values())
    .sort((a, b) => a.seq - b.seq)
    .slice(-MAX_VISIBLE_LINES);
}

interface Props {
  relayMessages?: RelayMessageView[] | undefined;
}

export function CommentaryFeed(props: Props) {
  const items = useMemo(() => selectCommentary(props.relayMessages), [props.relayMessages]);
  if (items.length === 0) return null;
  return (
    <div
      className="kibitzer-overlay"
      // Inline styles keep the plugin self-contained — no Tailwind /
      // CSS module dependency on the host shell.
      style={{
        position: 'absolute',
        right: 12,
        bottom: 12,
        maxWidth: 320,
        padding: '8px 12px',
        background: 'rgba(0, 0, 0, 0.65)',
        color: '#f5f5dc',
        fontFamily: 'Georgia, "Times New Roman", serif',
        fontSize: 13,
        borderRadius: 6,
        pointerEvents: 'none',
        zIndex: 50,
      }}
      data-testid="kibitzer-overlay"
    >
      <div
        style={{
          fontSize: 10,
          letterSpacing: 1,
          opacity: 0.7,
          marginBottom: 4,
          textTransform: 'uppercase',
        }}
      >
        Kibitzer
      </div>
      {items.map((it) => (
        <div key={it.seq} style={{ marginTop: 2 }}>
          {it.text}
        </div>
      ))}
    </div>
  );
}
