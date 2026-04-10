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
}

export async function fetchLobbies(): Promise<any[]> {
  return request<any[]>('/lobbies');
}

export async function fetchGames(): Promise<GameSummary[]> {
  return request<GameSummary[]>('/games');
}

export async function fetchGame(id: string): Promise<any> {
  return request<any>(`/games/${id}`);
}

export async function fetchLeaderboard(): Promise<any[]> {
  return request<any[]>('/leaderboard');
}

export async function fetchReplay(id: string): Promise<any> {
  return request<any>(`/replays/${id}`);
}

export interface LobbySummary {
  lobbyId: string;
  gameType: string;
  phase: 'running' | 'starting' | 'game' | 'failed';
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
