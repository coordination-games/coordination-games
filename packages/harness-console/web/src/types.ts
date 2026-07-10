/** Mirrors of the console server's response shapes (src/*.ts server-side). */

export interface RunOutcome {
  phase?: string;
  round?: number;
  isFinished?: boolean;
  winnerLabel?: string | null;
  statusVariant?: string | null;
  outcome?: unknown;
  summary?: unknown;
}

export interface CampaignRunSummary {
  label: string;
  game: string;
  /** 'running'/'incomplete' are console-synthesized for manifest-less run dirs. */
  status: 'ok' | 'error' | 'running' | 'incomplete';
  runDir?: string;
  lobbyId?: string;
  gameId?: string;
  analysis?: boolean;
  outcome?: RunOutcome | null;
  error?: string;
}

export interface CampaignInfo {
  id: string;
  complete: boolean;
  total: number;
  startedAt: number | null;
  runs: CampaignRunSummary[];
}

export interface ManifestSeat {
  bot: string;
  persona: string;
  model: string;
  backend: string;
}

export interface ManifestPerBot extends ManifestSeat {
  modelCalls: number;
  consequentialTurns: number;
  talkOnlyTurns: number;
  finished: boolean;
  reason: string;
}

export interface RunManifest {
  runId: string;
  spec: Record<string, unknown>;
  lobbyId?: string;
  gameId?: string;
  seats: ManifestSeat[];
  outcome?: RunOutcome | null;
  perBot: ManifestPerBot[];
}

export interface RunInfo {
  campaignId: string;
  runId: string;
  manifest: RunManifest | null;
  bots: string[];
  hasAnalysis: boolean;
  hasRelay: boolean;
}

/** AnalysisReport (packages/model-harness/src/analyze.ts). */
export interface AnalysisReport {
  betrayals?: {
    round?: number;
    actor?: string;
    victim?: string;
    evidence?: string[];
    severity?: number;
  }[];
  brokenPledges?: { pledge?: string; by?: string; round?: number; evidence?: string[] }[];
  deceptions?: { actor?: string; claim?: string; reality?: string; evidence?: string[] }[];
  coordination?: { participants?: string[]; description?: string; heldUntil?: string }[];
  perBot?: {
    bot?: string;
    persona?: string;
    model?: string;
    style?: string;
    consequentialTurns?: number;
    talkOnlyTurns?: number;
    trustworthiness?: number;
    notable?: string[];
  }[];
  notableMoments?: { round?: number; description?: string; relayRefs?: number[] }[];
  summary?: string;
}

export interface TranscriptEvent {
  t: number;
  bot: string;
  kind: 'model_request' | 'model_response' | 'tool_call' | 'tool_result' | 'session';
  [key: string]: unknown;
}

export interface JobPublic {
  id: string;
  kind: 'campaign' | 'analyze';
  status: 'running' | 'done' | 'error' | 'stopped';
  startedAt: number;
  endedAt?: number;
  specPath?: string;
  campaignId?: string;
  exitCode?: number | null;
}

export interface PersonaInfo {
  ref: string;
  name: string;
  source: 'bundled' | 'custom';
  text: string;
}

export interface ConsoleMeta {
  games: string[];
  personas: PersonaInfo[];
  modelSuggestions: { claude: string[]; openrouter: string[] };
  outputDir: string;
}

/** GET /api/demos entries — the front door's canned demonstrations. */
export interface DemoSummary {
  id: string;
  title: string;
  question: string;
  blurb: string;
  estMinutes: number;
}

export interface ModelAggregate {
  model: string;
  backend: string;
  seats: number;
  runs: number;
  wins: number;
  finished: number;
  consequentialTurns: number;
  talkOnlyTurns: number;
  avgTrustworthiness: number | null;
  trustSamples: number;
}

export interface GameServerStatus {
  reachable: boolean;
  target: string;
  managed: boolean;
  readyUrl: string | null;
  logs: string[];
}

export type SecretStatus = { openrouter: boolean; inspector: boolean; claude: boolean };

// --- campaign spec builder shapes (what POST /api/campaigns expects) ----------

export interface SeatDraft {
  persona: string;
  model: string;
  count: number;
}

export interface GameEntryDraft {
  game: string;
  rounds: number;
  params: Record<string, unknown>;
  seats: SeatDraft[];
  repeats?: number;
  label?: string;
  disablePlugins?: string[];
}

export interface CampaignSpecDraft {
  globals: {
    server?: string;
    identities?: 'ephemeral' | 'pool';
    output?: string;
    limits?: { maxModelCallsPerBot?: number; wallClockMsPerRun?: number };
    analysis?: { enabled: boolean; model?: string };
  };
  games: GameEntryDraft[];
}
