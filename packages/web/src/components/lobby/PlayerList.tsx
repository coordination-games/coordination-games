interface Agent {
  id: string;
  handle: string;
  team?: string | null;
  elo?: number;
}

function AgentCard({ agent }: { agent: Agent }) {
  return (
    <div className="rounded-lg px-3 py-2 text-sm parchment" style={{ borderColor: agent.team ? 'rgba(184, 134, 11, 0.3)' : undefined }}>
      <div className="font-semibold" style={{ color: 'var(--color-ink)' }}>{agent.handle}</div>
      <div className="text-xs font-mono" style={{ color: 'var(--color-ink-faint)' }}>{agent.id}</div>
      {agent.team && <div className="mt-1 text-xs font-heading" style={{ color: 'var(--color-amber)' }}>{agent.team}</div>}
    </div>
  );
}

export default function PlayerList({ agents }: { agents: Agent[] }) {
  return (
    <div>
      <h3 className="mb-3 font-heading text-sm font-semibold uppercase tracking-wider" style={{ color: 'var(--color-ink-faint)' }}>Agents ({agents.length})</h3>
      <div className="grid gap-2 grid-cols-2">
        {agents.map((a) => <AgentCard key={a.id} agent={a} />)}
      </div>
    </div>
  );
}
