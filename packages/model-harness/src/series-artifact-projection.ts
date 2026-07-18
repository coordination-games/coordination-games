import { redactText } from './gui/redact.js';
import type { ResolvedModelProfile } from './model-profile-types.js';
import type { ResolvedSeriesConfigInput, SeriesRawRelay } from './series-artifact-types.js';
import type { SeriesGameHistory, SeriesRelayEnvelope } from './series-context.js';

export function projectRelay(gameId: string, relay: SeriesRawRelay): SeriesRelayEnvelope {
  const messageBody = relay.type === 'messaging' ? body(relay.data) : undefined;
  const safeBody = messageBody ? redactBody(messageBody) : undefined;
  return {
    gameId,
    index: relay.index,
    type: relay.type,
    pluginId: relay.pluginId,
    sender: relay.sender,
    scope: relay.scope,
    turn: relay.turn,
    ...(safeBody ? { body: safeBody } : {}),
  };
}

export function projectOutcome(value: unknown): SeriesGameHistory['outcome'] {
  const source = record(value);
  return {
    ...(typeof source?.phase === 'string' ? { phase: source.phase } : {}),
    ...(typeof source?.winnerLabel === 'string' ? { winnerLabel: source.winnerLabel } : {}),
  };
}

export function projectBotEvent(value: unknown, gameId: string, gameIndex: number): unknown {
  const source = record(value);
  const base = {
    gameId,
    gameIndex,
    kind: typeof source?.kind === 'string' ? source.kind : 'unknown',
  };
  switch (source?.kind) {
    case 'tool_call':
      return { ...base, t: number(source.t), bot: string(source.bot), name: string(source.name) };
    case 'tool_result':
      return {
        ...base,
        t: number(source.t),
        bot: string(source.bot),
        name: string(source.name),
        stateVersion: number(source.stateVersion),
        relayCursor: number(source.relayCursor),
        isError: source.isError === true,
      };
    case 'model_response':
      return {
        ...base,
        t: number(source.t),
        bot: string(source.bot),
        usage: projectUsage(source.usage),
      };
    case 'model_request':
      return { ...base, t: number(source.t), bot: string(source.bot), model: string(source.model) };
    default:
      return {
        ...base,
        t: number(source?.t),
        bot: string(source?.bot),
        event: string(source?.event),
      };
  }
}

export function projectResolvedConfig(config: ResolvedSeriesConfigInput): unknown {
  return {
    game: config.game,
    params: projectSafeValue(config.params),
    limits: config.limits,
    tournament: config.tournament,
    disablePlugins: config.disablePlugins,
    seats: config.seats.map((seat) => ({
      bot: seat.bot,
      model: seat.model,
      backend: seat.backend,
      persona: seat.persona,
      ...(seat.modelConfig ? { modelConfig: projectModelConfig(seat.modelConfig) } : {}),
    })),
  };
}

export function visibleTo(
  relay: SeriesRelayEnvelope,
  viewer: { readonly playerId: string; readonly handle: string } | undefined,
): boolean {
  if (!viewer) return false;
  return (
    relay.scope.kind === 'all' ||
    relay.sender === viewer.playerId ||
    (relay.scope.kind === 'dm' &&
      (relay.scope.recipientHandle === viewer.playerId ||
        relay.scope.recipientHandle === viewer.handle))
  );
}

function projectModelConfig(config: ResolvedModelProfile): ResolvedModelProfile {
  return {
    provider: config.provider,
    model: config.model,
    ...(config.baseUrl ? { baseUrl: redactText(config.baseUrl) } : {}),
    ...(config.apiKeyEnv ? { apiKeyEnv: config.apiKeyEnv } : {}),
    ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
    ...(config.topP !== undefined ? { topP: config.topP } : {}),
    ...(config.maxCompletionTokens !== undefined
      ? { maxCompletionTokens: config.maxCompletionTokens }
      : {}),
    ...(config.reasoningSplit !== undefined ? { reasoningSplit: config.reasoningSplit } : {}),
    ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}),
    ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
    ...(config.retries !== undefined ? { retries: config.retries } : {}),
    ...(config.pricing ? { pricing: { ...config.pricing } } : {}),
  };
}

function projectUsage(value: unknown): unknown {
  const usage = record(value);
  if (!usage) return undefined;
  return Object.fromEntries(Object.entries(usage).filter(([, entry]) => typeof entry === 'number'));
}

function projectSafeValue(value: unknown): unknown {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(projectSafeValue);
  const entry = record(value);
  if (!entry) return value;
  return Object.fromEntries(
    Object.entries(entry).map(([key, child]) => [
      key,
      /(?:api[_-]?key|secret|password|credential|authorization|token)/i.test(key)
        ? '[REDACTED]'
        : projectSafeValue(child),
    ]),
  );
}

function body(value: unknown): string | undefined {
  const source = record(value);
  return typeof source?.body === 'string' ? source.body : undefined;
}

function redactBody(value: string): string | undefined {
  if (
    /(hidden[ _-]?reasoning|horizon[ _-]?secret|api[ _-]?key|private[ _-]?key|raw[ _-]?tool|\btoken\b)/i.test(
      value,
    )
  ) {
    return undefined;
  }
  return /0x[0-9a-f]{64}/i.test(value) ? '[REDACTED]' : redactText(value);
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return Object.fromEntries(Object.entries(value));
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}
