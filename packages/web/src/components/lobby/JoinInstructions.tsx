import { useState } from 'react';
import { buildJoinPrompt, getGameDisplayName, PLATFORM_INSTALL_COMMAND } from '../../games/manifest';

export default function JoinInstructions({ lobbyId, gameType }: { lobbyId: string; gameType?: string }) {
  const [copied, setCopied] = useState(false);
  const gameName = getGameDisplayName(gameType);
  const joinPrompt = buildJoinPrompt(lobbyId, gameType);

  function handleCopyInstall() {
    navigator.clipboard.writeText(PLATFORM_INSTALL_COMMAND).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); });
  }

  function handleCopyJoinPrompt() {
    navigator.clipboard.writeText(joinPrompt).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); });
  }

  return (
    <div className="rounded-lg parchment-strong p-4">
      <h3 className="mb-3 font-heading text-sm font-semibold uppercase tracking-wider" style={{ color: 'var(--color-ink-faint)' }}>Join with Your Agent</h3>
      <p className="mb-2 text-xs" style={{ color: 'var(--color-ink-light)' }}>1. Install the plugin (one time):</p>
      <div onClick={handleCopyInstall} className="cursor-pointer rounded px-3 py-2 font-mono text-xs transition-colors hover:brightness-95" title="Click to copy"
        style={{ background: 'rgba(42, 31, 14, 0.06)', color: 'var(--color-ink-light)', border: '1px solid rgba(42, 31, 14, 0.08)' }}>
        {PLATFORM_INSTALL_COMMAND}
      </div>
      <p className="mt-3 mb-2 text-xs" style={{ color: 'var(--color-ink-light)' }}>2. Tell your agent:</p>
      <div onClick={handleCopyJoinPrompt} className="cursor-pointer rounded px-3 py-2 font-mono text-xs transition-colors hover:brightness-95" title="Click to copy"
        style={{ background: 'rgba(42, 31, 14, 0.06)', color: 'var(--color-amber)', border: '1px solid rgba(184, 134, 11, 0.15)' }}>
        {`"Join lobby ${lobbyId} in Coordination Games and play ${gameName}, please!"`}
      </div>
      <p className="mt-2 text-xs" style={{ color: 'var(--color-ink-faint)' }}>{copied ? 'Copied!' : 'Click to copy'}</p>
    </div>
  );
}
