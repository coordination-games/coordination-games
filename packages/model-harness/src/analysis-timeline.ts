export type BotTimeline = {
  readonly botName: string;
  readonly persona: string;
  readonly model: string;
  readonly backend: string;
  readonly consequentialTurns: number;
  readonly talkOnlyTurns: number;
  readonly actionSummary: readonly unknown[];
};

type ManifestSeat = {
  readonly bot: string;
  readonly persona: string;
  readonly model: string;
  readonly backend: string;
};

type ManifestCounts = {
  readonly bot: string;
  readonly consequentialTurns: number;
  readonly talkOnlyTurns: number;
};

export function buildPerBotTimelines(
  botTranscripts: Readonly<Record<string, readonly unknown[]>>,
  manifest: unknown,
): readonly BotTimeline[] {
  const source = record(manifest);
  const seats = parseSeats(source?.seats);
  const perBotCounts = parseCounts(source?.perBot);
  return Object.entries(botTranscripts).map(([botName, events]) => {
    const seat = seats.find((entry) => entry.bot === botName);
    const counts = perBotCounts.find((entry) => entry.bot === botName) ?? recomputeCounts(events);
    return {
      botName,
      persona: seat?.persona ?? 'unknown',
      model: seat?.model ?? 'unknown',
      backend: seat?.backend ?? 'unknown',
      consequentialTurns: counts.consequentialTurns,
      talkOnlyTurns: counts.talkOnlyTurns,
      actionSummary: buildActionSummary(events),
    };
  });
}

function parseSeats(value: unknown): readonly ManifestSeat[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const seat = record(entry);
    if (
      typeof seat?.bot !== 'string' ||
      typeof seat.persona !== 'string' ||
      typeof seat.model !== 'string' ||
      typeof seat.backend !== 'string'
    ) {
      return [];
    }
    return [{ bot: seat.bot, persona: seat.persona, model: seat.model, backend: seat.backend }];
  });
}

function parseCounts(value: unknown): readonly ManifestCounts[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const counts = record(entry);
    if (
      typeof counts?.bot !== 'string' ||
      typeof counts.consequentialTurns !== 'number' ||
      typeof counts.talkOnlyTurns !== 'number'
    ) {
      return [];
    }
    return [
      {
        bot: counts.bot,
        consequentialTurns: counts.consequentialTurns,
        talkOnlyTurns: counts.talkOnlyTurns,
      },
    ];
  });
}

function recomputeCounts(events: readonly unknown[]): Omit<ManifestCounts, 'bot'> {
  let consequentialTurns = 0;
  let talkOnlyTurns = 0;
  let lastStateVersion: number | undefined;
  for (const event of events) {
    const entry = record(event);
    if (entry?.kind !== 'tool_result') continue;
    const stateVersion = typeof entry.stateVersion === 'number' ? entry.stateVersion : undefined;
    if (stateVersion !== undefined) {
      if (lastStateVersion === undefined || stateVersion > lastStateVersion) {
        consequentialTurns++;
        lastStateVersion = stateVersion;
      } else {
        talkOnlyTurns++;
      }
    } else {
      talkOnlyTurns++;
    }
  }
  return { consequentialTurns, talkOnlyTurns };
}

function buildActionSummary(events: readonly unknown[]): readonly unknown[] {
  const summary: unknown[] = [];
  for (let index = 0; index < events.length; index++) {
    const entry = record(events[index]);
    if (entry?.kind !== 'tool_call') continue;
    const next = record(events[index + 1]);
    summary.push({
      t: entry.t,
      tool: entry.name,
      args: entry.args,
      result: next?.kind === 'tool_result' ? next.result : undefined,
      stateVersion: next?.stateVersion,
    });
  }
  return summary;
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return Object.fromEntries(Object.entries(value));
}
