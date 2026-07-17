export const MODEL_PROVIDERS = [
  'claude-cli',
  'openrouter',
  'minimax',
  'openai-compatible',
  'scripted',
] as const;

export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

export type Pricing = {
  readonly promptPerMillion?: number;
  readonly completionPerMillion?: number;
};

export type ResolvedModelProfile = {
  readonly provider: ModelProvider;
  readonly model: string;
  readonly baseUrl?: string;
  readonly apiKeyEnv?: string;
  readonly temperature?: number;
  readonly topP?: number;
  readonly maxCompletionTokens?: number;
  readonly reasoningSplit?: boolean;
  readonly reasoningEffort?: string;
  readonly timeoutMs?: number;
  readonly retries?: number;
  readonly pricing?: Pricing;
};

export type NamedModelProfiles = Readonly<Record<string, ResolvedModelProfile>>;

export const PROVIDER_DEFAULTS: Readonly<
  Record<ModelProvider, Omit<ResolvedModelProfile, 'model' | 'provider'>>
> = {
  'claude-cli': {},
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY' },
  minimax: { baseUrl: 'https://api.minimax.io/v1', apiKeyEnv: 'MINIMAX_API_KEY' },
  'openai-compatible': {},
  scripted: {},
};
