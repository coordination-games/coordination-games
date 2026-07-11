import { deriveTournamentRoomName } from '@coordination-games/engine';
import '@coordination-games/game-tragedy-of-the-commons';
import { describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));

type Stored = Map<string, unknown>;
type Game = { result: 'playing' | 'finished'; settlement: string; readonly requests: Request[] };

function requireGame(games: ReadonlyMap<string, Game>, gameId: string): Game {
  const game = games.get(gameId);
  if (!game) throw new Error(`Missing game ${gameId}`);
  return game;
}

function requireRequest(game: Game, index: number): Request {
  const request = game.requests[index];
  if (!request) throw new Error(`Missing request ${index}`);
  return request;
}

function storage(values: Stored) {
  const alarms: number[] = [];
  return {
    alarms,
    get: async <T>(key: string) => values.get(key) as T | undefined,
    put: async (key: string, value: unknown) => void values.set(key, value),
    setAlarm: async (when: number) => void alarms.push(when),
  };
}

async function fixture(creditsByAgent: Readonly<Record<string, string>> = {}) {
  const { TournamentDO } = await import('./TournamentDO.js');
  const values: Stored = new Map();
  const store = storage(values);
  const games = new Map<string, Game>();
  const names: string[] = [];
  const rows = new Set<string>();
  const namespace = {
    idFromName: (name: string) => {
      names.push(name);
      return { name };
    },
    get: (id: { name: string }) => ({
      fetch: async (request: Request) => {
        const game = games.get(id.name) ?? {
          result: 'playing' as const,
          settlement: 'pending',
          requests: [],
        };
        games.set(id.name, game);
        game.requests.push(request);
        const path = new URL(request.url).pathname;
        if (path === '/result')
          return game.result === 'playing'
            ? new Response('', { status: 409 })
            : Response.json({
                outcome: {
                  rankings:
                    id.name === deriveTournamentRoomName('t', 0)
                      ? [
                          { id: 'a', vp: 3, influence: 1 },
                          { id: 'b', vp: 2, influence: 1 },
                          { id: 'c', vp: 1, influence: 1 },
                        ]
                      : [
                          { id: 'a', vp: 2, influence: 1 },
                          { id: 'b', vp: 1, influence: 1 },
                        ],
                  roundsPlayed: 1,
                  flourishingEcosystems: 1,
                  collapsedEcosystems: 0,
                  commonsHealthPercent: 50,
                },
              });
        if (path === '/settlement-status')
          return Response.json({ state: { kind: game.settlement } });
        if (path === '/')
          return new Response('', {
            status:
              game.requests.filter((r) => new URL(r.url).pathname === '/').length > 1 ? 409 : 201,
          });
        return Response.json({ ok: true });
      },
    }),
  };
  const env = {
    GAME_ROOM: namespace,
    DB: {
      prepare: (sql: string) => ({
        bind: (...args: string[]) => ({
          first: async () => ({
            chain_agent_id: Number(args[0] === 'a' ? 1 : args[0] === 'b' ? 2 : 3),
          }),
          run: async () => {
            if (sql.includes('INSERT OR IGNORE')) rows.add(args[0] ?? '');
          },
        }),
      }),
    },
  };
  const make = () =>
    Object.assign(Object.create(TournamentDO.prototype), {
      ctx: { id: { name: 't' }, storage: store },
      env,
      getPlayerCredits: async (id: string) => creditsByAgent[id] ?? (id === '3' ? '1' : '100'),
    });
  return { make, games, names, rows, store };
}

const payload = {
  tournamentId: 't',
  gameType: 'tragedy-of-the-commons',
  playerEntries: [
    { id: 'a', handle: 'a' },
    { id: 'b', handle: 'b' },
    { id: 'c', handle: 'c' },
  ],
  policy: {
    seriesLength: 2,
    baseEntryCost: '10',
    carryBps: 2_000,
    slashBps: 500,
    minRounds: 1,
    maxRounds: 2,
    hazardNumerator: 1,
    hazardDenominator: 1,
  },
  tournamentRootSeed: `0x${'11'.repeat(32)}`,
  playerEntropy: `0x${'22'.repeat(32)}`,
};

describe('TournamentDO integration', () => {
  it('creates, gates settlement, eliminates, resumes, and completes exactly two games', async () => {
    // Given
    const f = await fixture();
    const game0 = deriveTournamentRoomName('t', 0);
    const game1 = deriveTournamentRoomName('t', 1);
    // When
    const create = await f
      .make()
      .fetch(new Request('https://do/', { method: 'POST', body: JSON.stringify(payload) }));
    // Then
    expect(create.status).toBe(201);
    expect(f.names).toEqual([game0]);
    expect(f.games.size).toBe(1);
    expect(f.store.alarms.length).toBeGreaterThan(0);
    const firstGame = requireGame(f.games, game0);
    const createBody = JSON.parse(await requireRequest(firstGame, 0).text());
    expect(createBody.tournamentCommitContext.policy.baseEntryCost).toBe('10');
    expect(createBody.tournamentCommitContext.economics.entryCost).toBe('10');
    expect(createBody.config.tournamentEconomics.entryCost).toBe('10');
    expect(createBody.config.hiddenHorizon.maxRounds).toBe(2);
    await f.make().fetch(new Request('https://do/tick', { method: 'POST' }));
    expect(f.games.size).toBe(1);
    firstGame.result = 'finished';
    await f.make().fetch(new Request('https://do/tick', { method: 'POST' }));
    expect(f.games.size).toBe(1);
    expect(f.store.alarms.length).toBeGreaterThan(1);
    firstGame.settlement = 'submitted';
    await f.make().fetch(new Request('https://do/tick', { method: 'POST' }));
    expect(f.games.size).toBe(1);
    firstGame.settlement = 'confirmed';
    await f.make().alarm();
    expect(f.games.size).toBe(2);
    expect(f.names.at(-1)).toBe(game1);
    const secondGame = requireGame(f.games, game1);
    const game1Body = JSON.parse(await requireRequest(secondGame, 0).text());
    expect(game1Body.playerIds).toEqual(['a', 'b']);
    expect(game1Body.tournamentCommitContext.economics.entryCost).toBe('13');
    expect(game1Body.config.tournamentEconomics.entryCost).toBe('13');
    const afterGame0 = await (await f.make().fetch(new Request('https://do/state'))).json();
    expect(afterGame0.eliminatedPlayerIds).toEqual(['c']);
    expect(afterGame0.activePlayerIds).toEqual(['a', 'b']);
    expect(afterGame0.policy).toEqual({ baseEntryCost: '10', carryBps: '2000', slashBps: '500' });
    expect(afterGame0.treasuryCarry).toBe('6');
    expect(afterGame0.currentEconomics).toMatchObject({ entryCost: '13', carry: '5', slash: '1' });
    expect(afterGame0.lastSettlement).toMatchObject({
      gameId: game0,
      entryCost: '10',
      carry: '6',
      slash: '1',
      treasuryDelta: '7',
    });
    await f.make().fetch(new Request('https://do/tick', { method: 'POST' }));
    expect(f.games.size).toBe(2);
    expect(f.rows).toEqual(new Set([game0, game1]));
    expect(
      firstGame.requests.filter((request) => new URL(request.url).pathname === '/'),
    ).toHaveLength(1);
    expect(
      secondGame.requests.filter((request) => new URL(request.url).pathname === '/'),
    ).toHaveLength(1);
    secondGame.result = 'finished';
    secondGame.settlement = 'confirmed';
    await f.make().alarm();
    const state = await (await f.make().fetch(new Request('https://do/state'))).json();
    expect(state.status).toBe('completed');
    expect(state.gameIds).toEqual([game0, game1]);
    expect(JSON.stringify(state)).not.toMatch(/seed|entropy|secret|endpoint/i);
    await f.make().fetch(new Request('https://do/tick', { method: 'POST' }));
    await f.make().alarm();
    expect(f.games.size).toBe(2);
    expect(f.rows).toEqual(new Set([game0, game1]));
  });

  it('Given a balance between the current and frozen next entry costs, when game zero confirms, then it eliminates the player before next spawn', async () => {
    // Given
    const f = await fixture({ '1': '100', '2': '11', '3': '1' });
    const game0 = deriveTournamentRoomName('t', 0);
    const create = await f
      .make()
      .fetch(new Request('https://do/', { method: 'POST', body: JSON.stringify(payload) }));
    if (!create.ok) throw new Error(await create.text());
    const firstGame = requireGame(f.games, game0);
    firstGame.result = 'finished';
    firstGame.settlement = 'confirmed';

    // When
    await f.make().alarm();

    // Then
    const state = await (await f.make().fetch(new Request('https://do/state'))).json();
    expect(state.activePlayerIds).toEqual(['a']);
    expect(state.eliminatedPlayerIds).toEqual(['b', 'c']);
    expect(state.status).toBe('completed');
    expect(f.games.size).toBe(1);
  });
});
