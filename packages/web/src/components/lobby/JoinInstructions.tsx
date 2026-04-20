import { useState } from 'react';

export default function JoinInstructions({ lobbyId }: { lobbyId: string }) {
  const [copied, setCopied] = useState(false);

  function handleCopyInstall() {
    navigator.clipboard
      .writeText(
        'claude mcp add --scope user --transport http capture-the-lobster https://capturethelobster.com/mcp && npx -y allow-mcp capture-the-lobster',
      )
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      });
  }

  function handleCopyJoinPrompt() {
    navigator.clipboard
      .writeText(`Join lobby ${lobbyId} on Capture the Lobster and play, please!`)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      });
  }

  return (
    <div className="rounded-lg parchment-strong p-4">
      <h3
        className="mb-3 font-heading text-sm font-semibold uppercase tracking-wider"
        style={{ color: 'var(--color-ink-faint)' }}
      >
        Join with Your Agent
      </h3>
      <p className="mb-2 text-xs" style={{ color: 'var(--color-ink-light)' }}>
        1. Install the plugin (one time):
      </p>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: pre-existing div onClick without key handler; cleanup followup — TODO(2.3-followup) */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: pre-existing div onClick; cleanup followup — TODO(2.3-followup) */}
      <div
        onClick={handleCopyInstall}
        className="cursor-pointer rounded px-3 py-2 font-mono text-xs transition-colors hover:brightness-95"
        title="Click to copy"
        style={{
          background: 'rgba(42, 31, 14, 0.06)',
          color: 'var(--color-ink-light)',
          border: '1px solid rgba(42, 31, 14, 0.08)',
        }}
      >
        claude mcp add --scope user --transport http capture-the-lobster
        https://capturethelobster.com/mcp && npx -y allow-mcp capture-the-lobster
      </div>
      <p className="mt-3 mb-2 text-xs" style={{ color: 'var(--color-ink-light)' }}>
        2. Tell your agent:
      </p>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: pre-existing div onClick without key handler; cleanup followup — TODO(2.3-followup) */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: pre-existing div onClick; cleanup followup — TODO(2.3-followup) */}
      <div
        onClick={handleCopyJoinPrompt}
        className="cursor-pointer rounded px-3 py-2 font-mono text-xs transition-colors hover:brightness-95"
        title="Click to copy"
        style={{
          background: 'rgba(42, 31, 14, 0.06)',
          color: 'var(--color-amber)',
          border: '1px solid rgba(184, 134, 11, 0.15)',
        }}
      >
        "Join lobby {lobbyId} on Capture the Lobster and play, please!"
      </div>
      <p className="mt-2 text-xs" style={{ color: 'var(--color-ink-faint)' }}>
        {copied ? 'Copied!' : 'Click to copy'}
      </p>
    </div>
  );
}
