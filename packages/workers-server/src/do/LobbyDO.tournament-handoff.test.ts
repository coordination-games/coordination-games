import { getGame } from '@coordination-games/engine';
import '@coordination-games/game-tragedy-of-the-commons';
import { describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));

const tournamentPolicy = {
  seriesLength: 2,
  baseEntryCost: '10',
  carryBps: 1_000,
  slashBps: 500,
  minRounds: 2,
  maxRounds: 8,
  hazardNumerator: 1,
  hazardDenominator: 3,
} as const;

function createStorage() {
  const values = new Map<string, unknown>();
  return {
    values,
    async get(key: string): Promise<unknown> {
      return values.get(key);
    },
    async put(key: string, value: unknown): Promise<void> {
      values.set(key, value);
    },
    async delete(_key: string): Promise<boolean> {
      return true;
    },
    async list(): Promise<Map<string, unknown>> {
      return new Map();
    },
    async deleteAlarm(): Promise<void> {},
  };
}

async function createLobby(options: { readonly tournamentStatus?: number } = {}): Promise<{
  readonly lobby: object;
  readonly tournamentRequests: Request[];
  readonly gameRequests: Request[];
  readonly storage: ReturnType<typeof createStorage>;
}> {
  const { LobbyDO } = await import('./LobbyDO.js');
  const storage = createStorage();
  const tournamentRequests: Request[] = [];
  const gameRequests: Request[] = [];
  const tournamentId = 'lobby:lobby-tournament';
  const gameId = 'tournament-game-0';
  const tournament = {
    idFromName(name: string) {
      return { name };
    },
    get(_id: { readonly name: string }) {
      return {
        async fetch(request: Request): Promise<Response> {
          tournamentRequests.push(request);
          if (request.method === 'GET') return Response.json({ currentGameId: gameId });
          return Response.json(
            { tournamentId, currentGameId: gameId, status: 'running' },
            { status: options.tournamentStatus ?? 201 },
          );
        },
      };
    },
  };
  const gameRoom = {
    idFromName(name: string) {
      return { name };
    },
    get(_id: { readonly name: string }) {
      return {
        async fetch(request: Request): Promise<Response> {
          gameRequests.push(request);
          return Response.json({ ok: true }, { status: 201 });
        },
      };
    },
  };
  const lobby = Object.create(LobbyDO.prototype) as object;
  Reflect.set(lobby, '_loaded', true);
  Reflect.set(lobby, 'ctx', {
    id: { name: 'lobby-tournament' },
    storage,
    getWebSockets: () => [] as WebSocket[],
  });
  Reflect.set(lobby, 'env', {
    DB: {
      prepare() {
        return {
          bind() {
            return { run: async () => ({}) };
          },
        };
      },
    },
    GAME_ROOM: gameRoom,
    TOURNAMENT: tournament,
  });
  Reflect.set(lobby, '_meta', {
    lobbyId: 'lobby-tournament',
    gameType: 'tragedy-of-the-commons',
    currentPhaseIndex: 0,
    accumulatedMetadata: { disabledPlugins: ['basic-chat'] },
    tournament: { mode: 'tragedy-series', policy: tournamentPolicy },
    phase: 'lobby',
    deadlineMs: null,
    gameId: null,
    error: null,
    noTimeout: true,
    createdAt: 0,
  });
  Reflect.set(lobby, '_agents', [
    { id: 'player-a', handle: 'alice', elo: 1_200, joinedAt: 1 },
    { id: 'player-b', handle: 'bob', elo: 1_100, joinedAt: 2 },
  ]);
  const firstPhase = getGame('tragedy-of-the-commons')?.lobby?.phases[0];
  if (!firstPhase) throw new Error('Tragedy lobby phase missing');
  Reflect.set(lobby, '_phaseState', firstPhase.init([], {}));
  Reflect.set(lobby, '_stateVersion', 0);
  return { lobby, tournamentRequests, gameRequests, storage };
}

async function handoff(lobby: object): Promise<void> {
  const doCreateGame = Reflect.get(lobby, 'doCreateGame');
  if (typeof doCreateGame !== 'function') throw new Error('LobbyDO handoff missing');
  await Reflect.apply(doCreateGame, lobby, []);
}

async function getPublicState(lobby: object): Promise<unknown> {
  const fetch = Reflect.get(lobby, 'fetch');
  if (typeof fetch !== 'function') throw new Error('LobbyDO fetch missing');
  const response = await Reflect.apply(fetch, lobby, [new Request('https://do/state')]);
  if (!(response instanceof Response)) throw new Error('LobbyDO state response missing');
  return response.json();
}

describe('LobbyDO tournament handoff', () => {
  it('hands exact public entries and policy to TournamentDO while retaining private material internally', async () => {
    // Given
    const fixture = await createLobby();
    // When
    await handoff(fixture.lobby);
    // Then
    expect(fixture.tournamentRequests).toHaveLength(1);
    expect(fixture.gameRequests).toHaveLength(0);
    const request = fixture.tournamentRequests[0];
    if (!request) throw new Error('Tournament request missing');
    const body = await request.json();
    expect(body).toMatchObject({
      tournamentId: 'lobby:lobby-tournament',
      gameType: 'tragedy-of-the-commons',
      playerEntries: [
        { id: 'player-a', handle: 'alice' },
        { id: 'player-b', handle: 'bob' },
      ],
      policy: tournamentPolicy,
      disabledPlugins: ['basic-chat'],
    });
    expect(JSON.stringify(body)).toMatch(/"tournamentRootSeed":"0x[0-9a-f]{64}"/);
    expect(JSON.stringify(body)).toMatch(/"playerEntropy":"0x[0-9a-f]{64}"/);
    const stored = fixture.storage.values.get('meta');
    expect(JSON.stringify(stored)).toContain('lobby:lobby-tournament');
    expect(JSON.stringify(stored)).toContain('tournament-game-0');
    expect(JSON.stringify(stored)).not.toMatch(/seed|entropy|secret/i);
    const publicState = await getPublicState(fixture.lobby);
    expect(JSON.stringify(publicState)).toContain('lobby:lobby-tournament');
    expect(JSON.stringify(publicState)).not.toMatch(/seed|entropy|secret/i);
  });

  it('resumes a 409 TournamentDO create by reading its current game and leaves the legacy mode GameRoom-only', async () => {
    // Given
    const tournamentFixture = await createLobby({ tournamentStatus: 409 });
    const legacyFixture = await createLobby();
    const legacyMeta = Reflect.get(legacyFixture.lobby, '_meta');
    if (typeof legacyMeta !== 'object' || legacyMeta === null)
      throw new Error('Legacy meta missing');
    Reflect.deleteProperty(legacyMeta, 'tournament');
    // When
    await handoff(tournamentFixture.lobby);
    await handoff(legacyFixture.lobby);
    // Then
    expect(tournamentFixture.tournamentRequests).toHaveLength(2);
    expect(new URL(tournamentFixture.tournamentRequests[1]?.url ?? '').pathname).toBe('/state');
    expect(tournamentFixture.gameRequests).toHaveLength(0);
    expect(legacyFixture.tournamentRequests).toHaveLength(0);
    expect(legacyFixture.gameRequests.map((request) => new URL(request.url).pathname)).toEqual([
      '/',
      '/action',
    ]);
  });
});
