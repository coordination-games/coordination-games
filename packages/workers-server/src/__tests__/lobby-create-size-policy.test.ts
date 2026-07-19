import type {
  D1Database,
  DurableObjectNamespace,
  ExecutionContext,
} from '@cloudflare/workers-types';
import { type LobbyPhase, LobbySizeError } from '@coordination-games/engine';
import {
  CTL_DEFAULT_TEAM_SIZE,
  CTL_GAME_ID,
  CTL_MAX_TEAM_SIZE,
  CTL_MIN_TEAM_SIZE,
} from '@coordination-games/game-ctl';
import { GeniusPlugin } from '@coordination-games/game-genius';
import { OathbreakerPlugin } from '@coordination-games/game-oathbreaker';
import { TragedyOfTheCommonsV2Plugin } from '@coordination-games/game-tragedy-of-the-commons';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Env } from '../env.js';
import { readJson } from './test-helpers.js';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {},
}));

type WorkerModule = typeof import('../index.js');
let worker: WorkerModule['default'];

beforeAll(async () => {
  const module = await import('../index.js');
  worker = module.default;
});

type WorkerEffects = {
  readonly inserts: unknown[][];
  readonly doNames: string[];
  readonly doRequests: Request[];
};

function makeD1(effects: WorkerEffects): D1Database {
  const stub = {
    prepare(sql: string) {
      if (!sql.startsWith('INSERT INTO lobbies')) {
        throw new Error(`Unexpected SQL in lobby-create test: ${sql}`);
      }
      const statement = {
        bindings: [] as unknown[],
        bind(...bindings: unknown[]) {
          this.bindings = bindings;
          return this;
        },
        async run() {
          effects.inserts.push(this.bindings);
          return { success: true };
        },
      };
      return statement;
    },
  };
  return stub as unknown as D1Database;
}

function makeLobbyNamespace(effects: WorkerEffects): DurableObjectNamespace {
  const namespace = {
    idFromName(name: string) {
      effects.doNames.push(name);
      return { name };
    },
    get(_id: { readonly name: string }) {
      return {
        async fetch(request: Request): Promise<Response> {
          effects.doRequests.push(request);
          return Response.json({ ok: true });
        },
      };
    },
  };
  return namespace as unknown as DurableObjectNamespace;
}

function makeTournamentNamespace(effects: WorkerEffects): DurableObjectNamespace {
  const namespace = {
    idFromName(name: string) {
      effects.doNames.push(name);
      return { name };
    },
    get(_id: { readonly name: string }) {
      return {
        async fetch(request: Request): Promise<Response> {
          effects.doRequests.push(request);
          return Response.json({ ok: true });
        },
      };
    },
  };
  return namespace as unknown as DurableObjectNamespace;
}

function makeWorkerFixture(): { readonly env: Env; readonly effects: WorkerEffects } {
  const effects: WorkerEffects = { inserts: [], doNames: [], doRequests: [] };
  const env: Env = {
    DB: makeD1(effects),
    LOBBY: makeLobbyNamespace(effects),
    GAME_ROOM: {} as DurableObjectNamespace,
    ENVIRONMENT: 'test',
  };
  return { env, effects };
}

const executionContext: ExecutionContext = {
  waitUntil() {},
  passThroughOnException() {},
  props: {},
};

function createLobbyRequest(body: Record<string, unknown>): Request {
  return new Request('https://worker/api/lobbies/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function phaseCapacity(
  phase: LobbyPhase,
  config: Record<string, unknown>,
): number | null | undefined {
  return phase.capacity?.(phase.init([], config));
}

describe('registered game first-phase size policies', () => {
  it.each([
    {
      name: 'Oathbreaker',
      phase: OathbreakerPlugin.lobby?.phases[0],
      policy: { min: 4, max: 20, default: 4, unit: 'player-count' },
    },
    {
      name: 'Tragedy',
      phase: TragedyOfTheCommonsV2Plugin.lobby?.phases[0],
      policy: { min: 3, max: 6, default: 4, unit: 'player-count' },
    },
    {
      name: 'Genius',
      phase: GeniusPlugin.lobby?.phases[0],
      policy: { min: 2, max: 4, default: 3, unit: 'player-count' },
    },
  ])('$name accepts exact bounds, defaults missing input, and rejects values outside policy', ({
    phase,
    policy,
  }) => {
    // Given
    if (phase === undefined) throw new Error('Registered first phase missing');

    // When
    const minimumCapacity = phaseCapacity(phase, { teamSize: policy.min });
    const maximumCapacity = phaseCapacity(phase, { teamSize: policy.max });
    const defaultCapacity = phaseCapacity(phase, {});

    // Then
    expect(phase.sizePolicy).toEqual(policy);
    expect(minimumCapacity).toBe(policy.min);
    expect(maximumCapacity).toBe(policy.max);
    expect(defaultCapacity).toBe(policy.default);
    expect(() => phase.init([], { teamSize: policy.min - 1 })).toThrowError(LobbySizeError);
    expect(() => phase.init([], { teamSize: policy.max + 1 })).toThrowError(LobbySizeError);
  });
});

describe('Worker create-lobby size boundary', () => {
  it.each([
    1,
    7,
    2.5,
    '2',
    null,
  ])('returns 400 for unsupported CTL wire size %s before D1 or Durable Object access', async (teamSize) => {
    // Given
    const fixture = makeWorkerFixture();

    // When
    const response = await worker.fetch(
      createLobbyRequest({ gameType: CTL_GAME_ID, teamSize }),
      fixture.env,
      executionContext,
    );

    // Then
    expect(response.status).toBe(400);
    expect((await readJson(response)).error).toMatch(/team-size.*2.*6/i);
    expect(fixture.effects.inserts).toEqual([]);
    expect(fixture.effects.doNames).toEqual([]);
    expect(fixture.effects.doRequests).toEqual([]);
  });

  it('returns 400 for an unknown game before D1 or Durable Object access', async () => {
    // Given
    const fixture = makeWorkerFixture();

    // When
    const response = await worker.fetch(
      createLobbyRequest({ gameType: 'unsupported-game', teamSize: 2 }),
      fixture.env,
      executionContext,
    );

    // Then
    expect(response.status).toBe(400);
    expect((await readJson(response)).error).toMatch(/unknown game type/i);
    expect(fixture.effects.inserts).toEqual([]);
    expect(fixture.effects.doNames).toEqual([]);
    expect(fixture.effects.doRequests).toEqual([]);
  });

  it.each([
    { teamSize: CTL_MIN_TEAM_SIZE, capacity: 4 },
    { teamSize: CTL_MAX_TEAM_SIZE, capacity: 12 },
  ])('persists and advertises canonical CTL capacity $capacity for size $teamSize', async ({
    teamSize,
    capacity,
  }) => {
    // Given
    const fixture = makeWorkerFixture();

    // When
    const response = await worker.fetch(
      createLobbyRequest({ gameType: CTL_GAME_ID, teamSize }),
      fixture.env,
      executionContext,
    );
    const body = await readJson(response);

    // Then
    expect(response.status).toBe(201);
    expect(body.teamSize).toBe(teamSize);
    expect(body.capacity).toBe(capacity);
    expect(fixture.effects.inserts).toHaveLength(1);
    expect(fixture.effects.inserts[0]?.slice(1, 4)).toEqual([CTL_GAME_ID, teamSize, capacity]);
    expect(fixture.effects.doRequests).toHaveLength(1);
  });

  it('uses the CTL policy default when teamSize is omitted', async () => {
    // Given
    const fixture = makeWorkerFixture();

    // When
    const response = await worker.fetch(
      createLobbyRequest({ gameType: CTL_GAME_ID }),
      fixture.env,
      executionContext,
    );

    // Then
    expect(response.status).toBe(201);
    expect((await readJson(response)).teamSize).toBe(CTL_DEFAULT_TEAM_SIZE);
  });
});

describe('Worker tournament routes', () => {
  it('decodes an encoded lobby tournament identifier before Durable Object lookup', async () => {
    const fixture = makeWorkerFixture();
    fixture.env.TOURNAMENT = makeTournamentNamespace(fixture.effects);

    const response = await worker.fetch(
      new Request('https://worker/api/tournaments/lobby%3Aabc-123/state'),
      fixture.env,
      executionContext,
    );

    expect(response.status).toBe(200);
    expect(fixture.effects.doNames).toEqual(['lobby:abc-123']);
    expect(new URL(fixture.effects.doRequests[0]?.url ?? '').pathname).toBe('/state');
  });
});
