export type BetrayalRecord = {
  readonly round: number;
  readonly actor: string;
  readonly victim: string;
  readonly evidence: readonly string[];
  readonly severity: 1 | 2 | 3;
};

export type BrokenPledgeRecord = {
  readonly pledge: string;
  readonly by: string;
  readonly round: number;
  readonly evidence: readonly string[];
};

export type DeceptionRecord = {
  readonly actor: string;
  readonly claim: string;
  readonly reality: string;
  readonly evidence: readonly string[];
};

export type CoordinationRecord = {
  readonly participants: readonly string[];
  readonly description: string;
  readonly heldUntil?: number;
};

export type PerBotRecord = {
  readonly bot: string;
  readonly persona: string;
  readonly model: string;
  readonly style: string;
  readonly consequentialTurns: number;
  readonly talkOnlyTurns: number;
  readonly trustworthiness: 1 | 2 | 3 | 4 | 5;
  readonly notable: readonly string[];
};

export type NotableMoment = {
  readonly round: number;
  readonly description: string;
  readonly relayRefs: readonly number[];
};

export type AnalysisReport = {
  readonly betrayals: readonly BetrayalRecord[];
  readonly brokenPledges: readonly BrokenPledgeRecord[];
  readonly deceptions: readonly DeceptionRecord[];
  readonly coordination: readonly CoordinationRecord[];
  readonly perBot: readonly PerBotRecord[];
  readonly notableMoments: readonly NotableMoment[];
  readonly summary: string;
};

export function extractAnalysisJson(raw: string): unknown {
  const trimmed = raw.trim();
  const direct = parseJson(trimmed);
  if (direct.ok) return direct.value;

  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch?.[1]) {
    const fenced = parseJson(fenceMatch[1].trim());
    if (fenced.ok) return fenced.value;
  }

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end > start) {
    const candidate = parseJson(trimmed.slice(start, end + 1));
    if (candidate.ok) return candidate.value;
    throw new Error(
      `Could not parse JSON from model response. Parse error: ${String(candidate.error)}. ` +
        `Raw response start: ${trimmed.slice(0, 300)}`,
    );
  }

  throw new Error(
    `No JSON object found in model response. Raw response start: ${trimmed.slice(0, 300)}`,
  );
}

function parseJson(
  value: string,
):
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: unknown } {
  try {
    return { ok: true, value: JSON.parse(value) };
  } catch (error) {
    return { ok: false, error };
  }
}
