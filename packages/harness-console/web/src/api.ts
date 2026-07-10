import type {
  AnalysisReport,
  CampaignInfo,
  CampaignSpecDraft,
  ConsoleMeta,
  DemoSummary,
  Findings,
  GameServerStatus,
  JobPublic,
  LiveFeed,
  ModelAggregate,
  PreflightReport,
  RunInfo,
  SecretStatus,
  TranscriptEvent,
} from './types';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) {
    let message = `${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // Non-JSON error body.
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

const post = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

export const api = {
  meta: () => request<ConsoleMeta>('/api/meta'),
  preflight: () => request<PreflightReport>('/api/preflight'),
  demos: () => request<{ demos: DemoSummary[] }>('/api/demos'),
  runDemo: (id: string) => request<JobPublic>(`/api/demos/${encodeURIComponent(id)}/run`, post({})),
  campaigns: () => request<{ campaigns: CampaignInfo[] }>('/api/campaigns'),
  run: (c: string, r: string) =>
    request<RunInfo>(`/api/runs/${encodeURIComponent(c)}/${encodeURIComponent(r)}`),
  analysis: (c: string, r: string) =>
    request<AnalysisReport>(`/api/runs/${encodeURIComponent(c)}/${encodeURIComponent(r)}/analysis`),
  relay: (c: string, r: string) =>
    request<{ messages: unknown[] }>(
      `/api/runs/${encodeURIComponent(c)}/${encodeURIComponent(r)}/relay`,
    ),
  transcript: (c: string, r: string, bot: string, offset = 0) =>
    request<{ events: TranscriptEvent[]; nextOffset: number }>(
      `/api/runs/${encodeURIComponent(c)}/${encodeURIComponent(r)}/transcript/${encodeURIComponent(bot)}?offset=${offset}`,
    ),
  launch: (spec: CampaignSpecDraft, customPersonas: { name: string; text: string }[]) =>
    request<JobPublic>('/api/campaigns', post({ spec, customPersonas })),
  analyze: (campaign: string, run: string, model?: string) =>
    request<JobPublic>('/api/analyze', post({ campaign, run, model })),
  jobs: () => request<{ jobs: JobPublic[] }>('/api/jobs'),
  stopJob: (id: string) => request<JobPublic>(`/api/jobs/${encodeURIComponent(id)}/stop`, post({})),
  liveFeed: (gameId: string, since = -1) =>
    request<LiveFeed>(`/api/live/${encodeURIComponent(gameId)}/feed?since=${since}`),
  aggregate: () => request<{ models: ModelAggregate[] }>('/api/aggregate'),
  findings: (campaignId: string) =>
    request<Findings>(`/api/campaigns/${encodeURIComponent(campaignId)}/findings`),
  findingsHtmlUrl: (campaignId: string) =>
    `/api/campaigns/${encodeURIComponent(campaignId)}/findings.html`,
  secrets: () => request<SecretStatus>('/api/secrets'),
  setSecret: (name: string, value: string) =>
    request<SecretStatus>('/api/secrets', post({ name, value })),
  deleteSecret: (name: string) =>
    request<SecretStatus>(`/api/secrets/${name}`, { method: 'DELETE' }),
  serverStatus: (target: string) =>
    request<GameServerStatus>(`/api/server/status?target=${encodeURIComponent(target)}`),
  serverStart: () => request<{ started: boolean }>('/api/server/start', post({})),
  serverStop: () => request<{ stopped: boolean }>('/api/server/stop', post({})),
};
