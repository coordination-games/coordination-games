type AgentLike = { name?: string | null };
type PendingLike = { name?: string | null };

interface NameContext {
  agents?: Record<string, AgentLike | undefined>;
  pendingAgentInfo?: Record<string, PendingLike | undefined>;
}

const RUN_SUFFIX_PATTERN = /\s+[0-9a-f]{8}$/i;

function isLikelyTechnicalId(value: string): boolean {
  return /^[0-9a-f-]{12,}$/i.test(value) || /^[a-z0-9_-]{16,}$/i.test(value);
}

export function cleanAgentDisplayName(name: string): string {
  const cleaned = name.replace(/_/g, ' ').replace(RUN_SUFFIX_PATTERN, '').trim();
  return cleaned || name;
}

export function formatAgentName(agentId: string | null | undefined, context: NameContext = {}) {
  if (!agentId) return 'Unknown';
  const live = context.agents?.[agentId];
  if (live?.name) return cleanAgentDisplayName(live.name);
  const pending = context.pendingAgentInfo?.[agentId];
  if (pending?.name) return cleanAgentDisplayName(pending.name);
  const cleaned = cleanAgentDisplayName(String(agentId));
  if (!isLikelyTechnicalId(cleaned)) return cleaned;
  return shortName(agentId, context);
}

export function shortName(agentId: string | null | undefined, context: NameContext = {}): string {
  const name = formatRawName(agentId, context);
  if (isLikelyTechnicalId(name)) return name.length > 10 ? name.slice(0, 10) : name;
  return name.length > 28 ? `${name.slice(0, 25)}...` : name;
}

export function formatRawName(
  agentId: string | null | undefined,
  context: NameContext = {},
): string {
  if (!agentId) return 'Unknown';
  const live = context.agents?.[agentId];
  if (live?.name) return cleanAgentDisplayName(live.name);
  const pending = context.pendingAgentInfo?.[agentId];
  if (pending?.name) return cleanAgentDisplayName(pending.name);
  const cleaned = cleanAgentDisplayName(String(agentId));
  return isLikelyTechnicalId(cleaned) ? cleaned.slice(0, 6) : cleaned;
}
