import type { Commitment, VisibleBehaviorTag } from '../store';

export const SPECTRUM_SIZE = 7;

export const COOPERATION_LABELS = [
  'Betrayer',
  'Defector',
  'Wary',
  'Neutral',
  'Collaborator',
  'Ally',
  'Keystone',
] as const;

export const RELIABILITY_LABELS = [
  'Erratic',
  'Volatile',
  'Hesitant',
  'Steady',
  'Consistent',
  'Dependable',
  'Principled',
] as const;

export type CooperationLevel = (typeof COOPERATION_LABELS)[number];
export type ReliabilityLevel = (typeof RELIABILITY_LABELS)[number];

export interface TrustPosition {
  row: number; // 0..6 cooperation (0 = most hostile, 6 = most cooperative)
  col: number; // 0..6 reliability (0 = most erratic, 6 = most principled)
  cooperation: CooperationLevel;
  reliability: ReliabilityLevel;
  cooperationScore: number; // [-1, 1]
  reliabilityScore: number; // [-1, 1]
}

export interface TypologyContext {
  agentId: string;
  globalTrust?: number | null;
  peerScores?: number[]; // scores others gave this agent (direct trust column)
  commitments: Commitment[];
  behaviorTags: VisibleBehaviorTag[];
}

export interface TypologyReasons {
  cooperation: string[];
  reliability: string[];
}

export interface TypologyResult extends TrustPosition {
  reasons: TypologyReasons;
  stats: {
    fulfilledCount: number;
    breachedCount: number;
    pendingCount: number;
    totalCommitments: number;
    completionRatio: number;
    peerMean: number;
    peerVariance: number;
    positiveTags: number;
    negativeTags: number;
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function bucketFromScore(score: number): number {
  // map [-1, 1] -> 0..6
  const normalized = (clamp(score, -1, 1) + 1) / 2; // 0..1
  return clamp(Math.round(normalized * (SPECTRUM_SIZE - 1)), 0, SPECTRUM_SIZE - 1);
}

function toSignedDisplayTrust(score: number): number {
  return clamp(score, 0, 1) * 2 - 1;
}

const BREACH_STATUSES = new Set(['breached', 'breach', 'contest', 'contested', 'violated']);
const FULFILL_STATUSES = new Set(['fulfilled', 'fulfill', 'receive', 'honored', 'kept']);
const EXCLUDED_STATUSES = new Set(['non_triggered', 'non-triggered', 'non trigger']);

export function classifyCommitments(commitments: Commitment[], agentId: string) {
  let fulfilled = 0;
  let breached = 0;
  let pending = 0;
  for (const c of commitments) {
    if (c.promisor !== agentId) continue;
    const status = (c.resolutionStatus ?? '').toLowerCase();
    if (EXCLUDED_STATUSES.has(status)) continue;
    if (FULFILL_STATUSES.has(status)) fulfilled += 1;
    else if (BREACH_STATUSES.has(status)) breached += 1;
    else pending += 1;
  }
  return { fulfilled, breached, pending, total: fulfilled + breached + pending };
}

const BEHAVIOR_KIND_POLARITY: Record<string, -1 | 1> = {
  sabotage: -1,
  crisis_free_rider: -1,
  extractive: -1,
  opportunistic_targeting: -1,
  crisis_contributor: 1,
  stewardship: 1,
};

const NEGATIVE_TAG_HINTS = ['betray', 'defect', 'breach', 'hostil', 'violat', 'slashed', 'aggress'];
const POSITIVE_TAG_HINTS = ['cooperat', 'ally', 'keep', 'honor', 'fulfil', 'reciproc', 'steward'];

function tagPolarity(tag: VisibleBehaviorTag): -1 | 0 | 1 {
  const kind = tag.kind.toLowerCase();
  if (kind && kind in BEHAVIOR_KIND_POLARITY) {
    return BEHAVIOR_KIND_POLARITY[kind] ?? 0;
  }

  const label = `${tag.kind} ${tag.description}`.toLowerCase();
  if (!label) return 0;
  if (NEGATIVE_TAG_HINTS.some((hint) => label.includes(hint))) return -1;
  if (POSITIVE_TAG_HINTS.some((hint) => label.includes(hint))) return 1;
  return 0;
}

function tagsFor(tags: VisibleBehaviorTag[], agentId: string) {
  let positive = 0;
  let negative = 0;
  for (const t of tags) {
    if (t.actor !== agentId) continue;
    const p = tagPolarity(t);
    if (p > 0) positive += 1;
    else if (p < 0) negative += 1;
  }
  return { positive, negative };
}

function meanAndVariance(values: number[]) {
  if (!values.length) return { mean: 0, variance: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / values.length;
  return { mean, variance };
}

export function computeTypology(ctx: TypologyContext): TypologyResult {
  const peers = ctx.peerScores ?? [];
  const { mean: peerMean, variance: peerVariance } = meanAndVariance(peers);

  const c = classifyCommitments(ctx.commitments, ctx.agentId);
  const tags = tagsFor(ctx.behaviorTags, ctx.agentId);

  const global = typeof ctx.globalTrust === 'number' ? ctx.globalTrust : 0;
  const signedGlobal = toSignedDisplayTrust(global);
  const signedPeerMean = peers.length > 0 ? toSignedDisplayTrust(peerMean) : 0;

  // Cooperation axis: weighted blend of global trust, peer mean, net fulfilled,
  // and behavior polarity.
  const netCommit = c.total > 0 ? (c.fulfilled - c.breached) / c.total : 0;
  const tagBalance = (tags.positive - tags.negative) / Math.max(1, tags.positive + tags.negative);
  const cooperationScore = clamp(
    0.4 * signedGlobal + 0.25 * signedPeerMean + 0.2 * netCommit + 0.15 * tagBalance,
    -1,
    1,
  );

  // Reliability axis: completion ratio, variance of peer views (inverse), tag balance on fulfillment.
  const completionRatio = c.total > 0 ? c.fulfilled / c.total : 0.5; // neutral if no data
  const completionSigned = completionRatio * 2 - 1; // [-1,1]
  const consistencyFromVariance = clamp(1 - peerVariance * 2, -1, 1); // low variance -> +1
  const hasData = c.total > 0 || peers.length > 0;
  const reliabilityScore = hasData
    ? clamp(
        0.45 * completionSigned +
          0.3 * consistencyFromVariance +
          0.15 * tagBalance +
          0.1 * signedPeerMean,
        -1,
        1,
      )
    : 0;

  const row = bucketFromScore(cooperationScore);
  const col = bucketFromScore(reliabilityScore);

  const reasons: TypologyReasons = {
    cooperation: [],
    reliability: [],
  };

  if (typeof ctx.globalTrust === 'number') {
    reasons.cooperation.push(`Global trust ${global.toFixed(2)}`);
  }
  if (peers.length) {
    reasons.cooperation.push(
      `Peers average ${peerMean.toFixed(2)} across ${peers.length} view${peers.length === 1 ? '' : 's'}`,
    );
  }
  if (c.total > 0) {
    reasons.cooperation.push(`${c.fulfilled} fulfilled / ${c.breached} breached commitments`);
  }
  if (tags.positive || tags.negative) {
    reasons.cooperation.push(
      `${tags.positive} pro-social · ${tags.negative} hostile behavior tags`,
    );
  }

  if (c.total > 0) {
    reasons.reliability.push(`${Math.round(completionRatio * 100)}% commitment completion`);
  }
  if (peers.length > 1) {
    reasons.reliability.push(
      `Peer-view variance ${peerVariance.toFixed(2)} (${peerVariance < 0.08 ? 'tight agreement' : 'divergent signals'})`,
    );
  }
  if (c.pending > 0) {
    reasons.reliability.push(`${c.pending} commitment${c.pending === 1 ? '' : 's'} still pending`);
  }

  return {
    row,
    col,
    cooperation: COOPERATION_LABELS[row] ?? 'Neutral',
    reliability: RELIABILITY_LABELS[col] ?? 'Steady',
    cooperationScore,
    reliabilityScore,
    reasons,
    stats: {
      fulfilledCount: c.fulfilled,
      breachedCount: c.breached,
      pendingCount: c.pending,
      totalCommitments: c.total,
      completionRatio,
      peerMean,
      peerVariance,
      positiveTags: tags.positive,
      negativeTags: tags.negative,
    },
  };
}

export function describeTile(row: number, col: number): string {
  const coop = COOPERATION_LABELS[clamp(row, 0, SPECTRUM_SIZE - 1)];
  const rel = RELIABILITY_LABELS[clamp(col, 0, SPECTRUM_SIZE - 1)];
  const combined = `${coop} · ${rel}`;
  // A few curated narrative lines for memorable cells.
  if (row >= 5 && col >= 5)
    return `${combined} — keeps promises in plain view; a keystone peers lean on.`;
  if (row >= 5 && col <= 1)
    return `${combined} — warm intent, wobbly follow-through; allies hedge.`;
  if (row <= 1 && col >= 5)
    return `${combined} — reliably adversarial; you can set your watch by the betrayal.`;
  if (row <= 1 && col <= 1) return `${combined} — volatile and hostile; peers brace, not trust.`;
  if (row === 3 && col === 3)
    return `${combined} — the table reads this agent as an unknown, watching for a tell.`;
  if (row >= 4 && col >= 3) return `${combined} — leaning cooperative with steady hands.`;
  if (row <= 2 && col >= 3) return `${combined} — predictably uncooperative; trust is priced low.`;
  if (row >= 4 && col <= 2) return `${combined} — gestures generously, delivery is mixed.`;
  return `${combined} — mid-field presence; signals have not yet sharpened.`;
}

export function peerColumnFor(
  matrix: { agents: string[]; matrix: number[][] } | null | undefined,
  agentId: string,
): number[] {
  if (!matrix) return [];
  const idx = matrix.agents.indexOf(agentId);
  if (idx < 0) return [];
  const out: number[] = [];
  for (let r = 0; r < matrix.matrix.length; r += 1) {
    if (r === idx) continue;
    const row = matrix.matrix[r];
    if (!row || typeof row[idx] !== 'number') continue;
    out.push(row[idx]);
  }
  return out;
}
