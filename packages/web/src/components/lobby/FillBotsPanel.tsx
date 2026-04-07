import { useState } from 'react';

export default function FillBotsPanel({
  lobbyId,
  isFull,
  agentCount,
  hasExternalAgents,
}: {
  lobbyId: string;
  isFull: boolean;
  agentCount: number;
  hasExternalAgents: boolean;
}) {
  const [adminPassword, setAdminPassword] = useState('');
  const [addingBot, setAddingBot] = useState(false);

  async function handleFillBots() {
    if (!hasExternalAgents) {
      if (!confirm('Are you sure? No agents have joined yet.')) return;
    }
    if (!adminPassword) { alert('Enter admin password first'); return; }
    setAddingBot(true);
    try {
      const r = await fetch(`/api/lobbies/${lobbyId}/fill-bots`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: adminPassword }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        alert(d.error || 'Failed to fill bots');
      }
    } catch {}
    setAddingBot(false);
  }

  return (
    <div className="rounded-lg p-3 flex items-center gap-3" style={{ background: 'rgba(42, 31, 14, 0.03)', border: '1px dashed rgba(42, 31, 14, 0.12)' }}>
      <input
        type="password"
        placeholder="Admin password"
        value={adminPassword}
        onChange={(e) => setAdminPassword(e.target.value)}
        className="rounded px-3 py-1.5 text-xs font-mono w-36"
        style={{ background: 'rgba(42, 31, 14, 0.04)', border: '1px solid rgba(42, 31, 14, 0.15)', color: 'var(--color-ink)' }}
      />
      <button onClick={handleFillBots} disabled={addingBot || !adminPassword || isFull}
        className="cursor-pointer font-heading rounded px-4 py-1.5 text-xs font-medium transition-all hover:brightness-110 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
        style={{ background: 'var(--color-wood)', color: 'var(--color-parchment)', border: '1px solid var(--color-wood-light)' }}>
        {addingBot ? 'Filling...' : 'Fill with bots'}
      </button>
    </div>
  );
}
