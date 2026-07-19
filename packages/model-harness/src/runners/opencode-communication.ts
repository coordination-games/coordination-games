export type CommunicationCorrection = {
  readonly targetPlayerId: string;
  readonly publicChatSucceeded: boolean;
  readonly directChatSucceeded: boolean;
};

export type OpenCodeCommunicationState = {
  readonly publicChatSucceeded: boolean;
  readonly directChatSucceeded: boolean;
  readonly visibleTargetPlayerId?: string;
};

export type OpenCodeToolObservation = {
  readonly tool: string;
  readonly status: 'completed' | 'error';
  readonly args: Record<string, unknown>;
  readonly result: unknown;
};

export class OpenCodeCommunicationTracker {
  #publicChatSucceeded = false;
  #directChatSucceeded = false;
  #visibleTargetPlayerId: string | undefined;
  #visiblePlayerIds = new Set<string>();

  observe(observation: OpenCodeToolObservation): void {
    if (observation.status !== 'completed') return;
    if (observation.tool === 'coga_state' || observation.tool === 'coga_wait') {
      this.observeVisibleState(observation.result);
      return;
    }
    if (observation.tool !== 'coga_chat' || typeof observation.args.scope !== 'string') return;
    const scope = observation.args.scope.trim();
    if (scope === 'all' || scope === 'team') {
      this.#publicChatSucceeded = true;
    } else if (this.#visiblePlayerIds.has(scope)) {
      this.#directChatSucceeded = true;
    }
  }

  state(): OpenCodeCommunicationState {
    return {
      publicChatSucceeded: this.#publicChatSucceeded,
      directChatSucceeded: this.#directChatSucceeded,
      ...(this.#visibleTargetPlayerId
        ? { visibleTargetPlayerId: this.#visibleTargetPlayerId }
        : {}),
    };
  }

  correction(finished: boolean): CommunicationCorrection | undefined {
    if (
      finished ||
      !this.#visibleTargetPlayerId ||
      (this.#publicChatSucceeded && this.#directChatSucceeded)
    ) {
      return undefined;
    }
    return {
      targetPlayerId: this.#visibleTargetPlayerId,
      publicChatSucceeded: this.#publicChatSucceeded,
      directChatSucceeded: this.#directChatSucceeded,
    };
  }

  private observeVisibleState(value: unknown): void {
    const visible = findVisibleState(value);
    if (!visible) return;
    const selfId = stableId(record(visible.you)?.id);
    if (!selfId || !Array.isArray(visible.scoreboard)) return;
    const candidates = visible.scoreboard
      .map(record)
      .filter((entry): entry is Record<string, unknown> => entry !== undefined)
      .filter((entry) => entry.active !== false)
      .map((entry) => stableId(entry.id))
      .filter((id): id is string => id !== undefined && id !== selfId);
    this.#visiblePlayerIds = new Set(candidates);
    this.#visibleTargetPlayerId = candidates[0];
  }
}

function findVisibleState(value: unknown, depth = 0): Record<string, unknown> | undefined {
  if (depth > 3) return undefined;
  const current = record(value);
  if (!current) return undefined;
  if (record(current.you) && Array.isArray(current.scoreboard)) return current;
  for (const key of ['result', 'state', 'data'] as const) {
    const nested = findVisibleState(current[key], depth + 1);
    if (nested) return nested;
  }
  return undefined;
}

function stableId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}
