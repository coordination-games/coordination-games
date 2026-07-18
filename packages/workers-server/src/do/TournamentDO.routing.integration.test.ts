import { deriveTournamentRoomName } from '@coordination-games/engine';
import '@coordination-games/game-tragedy-of-the-commons';
import { describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));

type Game = {
  result: 'playing' | 'finished';
  settlement: 'pending' | 'confirmed';
  playerIds: readonly string[];
  readonly requests: Request[];
};

function requireGame(games: ReadonlyMap<string, Game>, gameId: string): Game {
  const game = games.get(gameId);
  if (!game) throw new Error(`Missing game ${gameId}`);
  return game;
}

function requirePlayerIds(value: unknown): readonly string[] {
  if (typeof value !== 'object' || value === null || !('playerIds' in value)) {
    throw new Error('Game create body did not include playerIds');
  }
  const playerIds = value.playerIds;
  if (!Array.isArray(playerIds) || !playerIds.every((playerId) => typeof playerId === 'string')) {
    throw new Error('Game create body playerIds were invalid');
  }
  return playerIds;
}

async function fixture() {
  const { TournamentDO } = await import('./TournamentDO.js');
  const values = new Map<string, unknown>();
  const games = new Map<string, Game>();
  const routing = {
    currentGameId: null as string | null,
    phase: null as string | null,
    eliminatedPlayerIds: [] as string[],
    completedPlayerIds: [] as string[],
  };
  const storage = {
    get: async <T>(key: string) => values.get(key) as T | undefined,
    put: async (key: string, value: unknown) => void values.set(key, value),
    setAlarm: async (_when: number) => {},
  };
  const namespace = {
    idFromName: (name: string) => ({ name }),
    get: (id: { readonly name: string }) => ({
      fetch: async (request: Request) => {
        const game = games.get(id.name) ?? {
          result: 'playing' as const,
          settlement: 'pending' as const,
          playerIds: [],
          requests: [],
        };
        games.set(id.name, game);
        game.requests.push(request);
        const path = new URL(request.url).pathname;
        if (path === '/result') {
          return game.result === 'playing'
            ? new Response('', { status: 409 })
            : Response.json({
                outcome: {
                  rankings: game.playerIds.map((id, index) => ({
                    id,
                    vp: game.playerIds.length - index,
                    influence: 1,
                  })),
                  roundsPlayed: 1,
                  flourishingEcosystems: 1,
                  collapsedEcosystems: 0,
                  commonsHealthPercent: 50,
                },
              });
        }
        if (path === '/settlement-status')
          return Response.json({ state: { kind: game.settlement } });
        if (path === '/') {
          game.playerIds = requirePlayerIds(await request.clone().json());
          return new Response('', { status: 201 });
        }
        return Response.json({ ok: true });
      },
    }),
  };
  const env = {
    GAME_ROOM: namespace,
    DB: {
      prepare: (_sql: string) => {
        const statement = {
          _bindings: [] as string[],
          bind(...args: string[]) {
            statement._bindings = args;
            return statement;
          },
          first: async () => ({
            chain_agent_id:
              statement._bindings[0] === 'survivor'
                ? 1
                : statement._bindings[0] === 'partner'
                  ? 2
                  : 3,
          }),
          run: async () => ({}),
        };
        return statement;
      },
      batch: async (statements: readonly { readonly _bindings?: readonly unknown[] }[]) => {
        const lobbyUpdate = statements[0];
        if (!lobbyUpdate?._bindings?.[1] || typeof lobbyUpdate._bindings[1] !== 'string') {
          throw new Error('Tournament routing batch did not update the lobby game id');
        }
        routing.currentGameId = lobbyUpdate._bindings[1];
        if (typeof lobbyUpdate._bindings[0] !== 'string') {
          throw new Error('Tournament routing batch did not set a lobby phase');
        }
        routing.phase = lobbyUpdate._bindings[0];
        const terminalUpdate = statements[1];
        const terminalBindings = terminalUpdate?._bindings ?? [];
        const eliminatedId = terminalBindings[0];
        const terminalState = terminalBindings[1];
        if (eliminatedId === 'eliminated') routing.eliminatedPlayerIds.push(eliminatedId);
        if (terminalState === 'completed') routing.completedPlayerIds.push('survivor', 'partner');
        return [];
      },
    },
  };
  const make = () =>
    Object.assign(Object.create(TournamentDO.prototype), {
      ctx: { id: { name: 'lobby:routing' }, storage },
      env,
      getPlayerCredits: async (agentId: string) => (agentId === '3' ? '0' : '100'),
    });
  return { games, make, routing };
}

const payload = {
  tournamentId: 'lobby:routing',
  gameType: 'tragedy-of-the-commons',
  playerEntries: [
    { id: 'survivor', handle: 'survivor' },
    { id: 'partner', handle: 'partner' },
    { id: 'eliminated', handle: 'eliminated' },
  ],
  policy: {
    seriesLength: 3,
    baseEntryCost: '10',
    carryBps: 0,
    slashBps: 0,
    minRounds: 1,
    maxRounds: 2,
    hazardNumerator: 1,
    hazardDenominator: 1,
  },
  tournamentRootSeed: `0x${'11'.repeat(32)}`,
  playerEntropy: `0x${'22'.repeat(32)}`,
};

describe('TournamentDO routing integration', () => {
  it('Given a three-game tournament, when each game settles, then D1 routes the same survivor through every current room in order', async () => {
    // Given
    const f = await fixture();
    const gameIds = [0, 1, 2].map((index) => deriveTournamentRoomName('lobby:routing', index));

    // When
    const create = await f
      .make()
      .fetch(new Request('https://do/', { method: 'POST', body: JSON.stringify(payload) }));

    // Then
    expect(create.status).toBe(201);
    for (const gameId of gameIds) {
      expect(f.routing.currentGameId).toBe(gameId);
      const game = requireGame(f.games, gameId);
      const createRequest = game.requests[0];
      if (!createRequest) throw new Error('Game create request missing');
      const playerIds = requirePlayerIds(await createRequest.json());
      expect(playerIds).toContain('survivor');
      if (gameId !== gameIds[0]) expect(playerIds).not.toContain('eliminated');
      game.result = 'finished';
      game.settlement = 'confirmed';
      await f.make().alarm();
    }
    expect(f.games.size).toBe(3);
    await f.make().alarm();
    expect(f.games.size).toBe(3);
    expect(f.routing.phase).toBe('finished');
    expect(f.routing.eliminatedPlayerIds).toContain('eliminated');
    expect(f.routing.completedPlayerIds).toEqual(['survivor', 'partner']);
  });
});
