type AgentLike = { name?: string | null };
type PendingLike = { name?: string | null };

interface NameContext {
  agents?: Record<string, AgentLike | undefined>;
  pendingAgentInfo?: Record<string, PendingLike | undefined>;
}

export function formatAgentName(agentId: string | null | undefined, context: NameContext = {}) {
  if (!agentId) return 'Unknown';
  const live = context.agents?.[agentId];
  if (live?.name) return live.name;
  const pending = context.pendingAgentInfo?.[agentId];
  if (pending?.name) return pending.name;
  return shortName(agentId, context);
}

export function shortName(agentId: string | null | undefined, context: NameContext = {}): string {
  const name = formatRawName(agentId, context);
  return name.length > 10 ? name.slice(0, 10) : name;
}

export function formatRawName(
  agentId: string | null | undefined,
  context: NameContext = {},
): string {
  if (!agentId) return 'Unknown';
  const live = context.agents?.[agentId];
  if (live?.name) return live.name.split('_')[0] ?? live.name;
  const pending = context.pendingAgentInfo?.[agentId];
  if (pending?.name) return pending.name.split('_')[0] ?? pending.name;
  return String(agentId).slice(0, 6);
}
