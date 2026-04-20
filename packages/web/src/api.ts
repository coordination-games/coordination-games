import { API_BASE as BASE } from './config.js';

async function request<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) {
    throw new Error(`API error ${res.status}: ${res.statusText}`);
  }
  return res.json();
}

export interface GameSummary {
  gameId: string;
  gameType: string;
  playerCount: number;
  finished: boolean;
  progressCounter: number;
  // CtL fields (from getSummary)
  turn?: number;
  maxTurns?: number;
  phase?: string;
  winner?: string;
  teams?: { A: string[]; B: string[] };
  // OATHBREAKER fields (from getSummary)
  round?: number;
  maxRounds?: number;
  players?: string[];
}

export async function fetchLobbies(): Promise<LobbySummary[]> {
  return request<LobbySummary[]>('/lobbies');
}

export async function fetchGames(): Promise<GameSummary[]> {
  return request<GameSummary[]>('/games');
}

/**
 * Game state payload shape is per-game; callers narrow at the SpectatorView boundary.
 */
export async function fetchGame(id: string): Promise<unknown> {
  return request<unknown>(`/games/${id}`);
}

export interface ReplayData {
  /**
   * 'replay' — snapshots contain 1..N entries representing progress ticks
   *            [0, publicSnapshotIndex()].
   * 'spectator_pending' — the game's spectator-delay window has not yet
   *            elapsed. snapshots is [] and progressCounter is null.
   */
  type?: 'replay' | 'spectator_pending';
  gameType: string;
  gameId: string;
  handles: Record<string, string>;
  teamMap: Record<string, string>;
  finished: boolean;
  progressCounter: number | null;
  /** Per-game snapshot shape; consumers narrow at the replay-view boundary. */
  snapshots: unknown[];
}

export async function fetchReplay(id: string): Promise<ReplayData> {
  return request<ReplayData>(`/games/${id}/replay`);
}

export interface LobbySummary {
  lobbyId: string;
  gameType: string;
  phase: 'lobby' | 'in_progress' | 'finished';
  currentPhase?: {
    id: string;
    name: string;
    view: unknown;
    tools?: unknown[];
  } | null;
  agents: Array<{ id: string; handle: string; elo?: number }>;
  relay?: unknown[];
  deadlineMs?: number | null;
  gameId?: string | null;
  error?: string | null;
  noTimeout?: boolean;
}

export async function fetchLobby(id: string): Promise<LobbySummary> {
  return request<LobbySummary>(`/lobbies/${id}`);
}

export async function fetchLobbiesList(): Promise<LobbySummary[]> {
  return request<LobbySummary[]>('/lobbies');
}
