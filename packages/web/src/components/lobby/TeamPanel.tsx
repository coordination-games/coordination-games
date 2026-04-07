interface Agent {
  id: string;
  handle: string;
}

export default function TeamPanel({
  teamId,
  team,
  agents,
}: {
  teamId: string;
  team: { members: string[]; invites: string[] };
  agents: Agent[];
}) {
  return (
    <div className="rounded-lg parchment-strong p-3">
      <h4 className="mb-2 text-sm font-heading font-semibold" style={{ color: 'var(--color-amber)' }}>{teamId}</h4>
      <div className="flex flex-wrap gap-2">
        {team.members.map((id) => {
          const agent = agents.find((a) => a.id === id);
          return <span key={id} className="rounded px-2 py-1 text-xs font-mono" style={{ background: 'rgba(42, 31, 14, 0.06)', color: 'var(--color-ink-light)' }}>{agent?.handle ?? id}</span>;
        })}
        {team.invites.map((id) => {
          const agent = agents.find((a) => a.id === id);
          return <span key={id} className="rounded px-2 py-1 text-xs font-mono italic" style={{ background: 'rgba(184, 134, 11, 0.06)', color: 'var(--color-amber-dim)', borderStyle: 'dashed', border: '1px dashed rgba(184, 134, 11, 0.3)' }}>{agent?.handle ?? id} (invited)</span>;
        })}
      </div>
    </div>
  );
}
