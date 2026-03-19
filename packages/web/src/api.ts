const BASE = '/api';

async function request<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) {
    throw new Error(`API error ${res.status}: ${res.statusText}`);
  }
  return res.json();
}

export async function fetchLobbies(): Promise<any[]> {
  return request<any[]>('/lobbies');
}

export async function fetchGames(): Promise<any[]> {
  return request<any[]>('/games');
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

export async function fetchLobby(id: string): Promise<any> {
  return request<any>(`/lobbies/${id}`);
}
