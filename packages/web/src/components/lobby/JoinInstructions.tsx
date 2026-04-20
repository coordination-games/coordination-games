import { useState } from 'react';
import { mcpInstallCommand } from '../../config.js';
import { getDefaultPlugin, getSpectatorPlugin } from '../../games';

interface Props {
  lobbyId: string;
  /**
   * The lobby's gameType. Used to look up branding so the join prompt
   * names the right game (via `branding.longName`). When absent or
   * unknown we fall back to the default plugin's branding.
   */
  gameType?: string;
}

export default function JoinInstructions({ lobbyId, gameType }: Props) {
  const [copied, setCopied] = useState(false);

  const plugin = (gameType ? getSpectatorPlugin(gameType) : undefined) ?? getDefaultPlugin();
  const { branding } = plugin;
  const installCmd = mcpInstallCommand();
  const joinPrompt = `Join lobby ${lobbyId} on ${branding.longName} and play, please!`;

  function handleCopyInstall() {
    navigator.clipboard.writeText(installCmd).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  function handleCopyJoinPrompt() {
    navigator.clipboard.writeText(joinPrompt).then(() => {
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
        Join {branding.longName} with Your Agent
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
        {installCmd}
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
        "{joinPrompt}"
      </div>
      <p className="mt-2 text-xs" style={{ color: 'var(--color-ink-faint)' }}>
        {copied ? 'Copied!' : 'Click to copy'}
      </p>
    </div>
  );
}
