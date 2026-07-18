import type { D1Database, DurableObjectNamespace } from '@cloudflare/workers-types';
import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../env.js';
import worker, { handlePlayerState } from '../index.js';
import { getPlayerLocation } from '../player-location.js';
import { dispatchToolCall } from '../tool-dispatcher.js';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
vi.mock('../auth.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../auth.js')>();
  return { ...original, consumeWsTicket: async () => 'player-1' };
});

type TerminalState = 'eliminated' | 'completed';

function makeEnv(terminalState: TerminalState): Env {
  const database = {
    prepare: (_sql: string) => ({
      bind: (_playerId: string) => ({
        first: async () => ({
          lobby_id: 'terminal-lobby',
          game_id: 'terminal-game',
          game_type: 'tragedy-of-the-commons',
          terminal_state: terminalState,
        }),
      }),
    }),
  } as unknown as D1Database;
  const unusedNamespace = {} as DurableObjectNamespace;
  return { DB: database, GAME_ROOM: unusedNamespace, LOBBY: unusedNamespace, ENVIRONMENT: 'test' };
}

function toolRequest(): Request {
  return new Request('https://worker/api/player/tool', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ toolName: 'move', args: {} }),
  });
}

function terminalNamespaces(): {
  readonly env: Env;
  readonly forwarded: { readonly lobby: number; readonly game: number };
} {
  const forwarded = { lobby: 0, game: 0 };
  const namespace = (kind: 'lobby' | 'game') =>
    ({
      get: () => ({
        fetch: async () => {
          forwarded[kind] += 1;
          return Response.json({ forwarded: kind });
        },
      }),
    }) as unknown as DurableObjectNamespace;
  return {
    env: {
      ...makeEnv('eliminated'),
      LOBBY: namespace('lobby'),
      GAME_ROOM: namespace('game'),
    },
    forwarded,
  };
}

describe('terminal player routing', () => {
  it.each([
    'eliminated',
    'completed',
  ] as const)('Given %s D1 state, when resolving player location, then it is terminal', async (terminalState) => {
    const location = await getPlayerLocation('player-1', makeEnv(terminalState));

    expect(location).toEqual({
      kind: terminalState,
      lobbyId: 'terminal-lobby',
      gameType: 'tragedy-of-the-commons',
    });
  });

  it.each([
    'eliminated',
    'completed',
  ] as const)('Given %s player, when reading state or wait, then both return the terminal body', async (terminalState) => {
    const env = makeEnv(terminalState);

    const state = await handlePlayerState('player-1', env);
    const wait = await handlePlayerState(
      'player-1',
      env,
      new Request('https://worker/api/player/wait'),
    );

    const expected = {
      status: terminalState,
      tournamentId: 'lobby:terminal-lobby',
      gameType: 'tragedy-of-the-commons',
    };
    expect(await state.json()).toEqual(expected);
    expect(await wait.json()).toEqual(expected);
  });

  it.each([
    ['eliminated', 'TOURNAMENT_ELIMINATED'],
    ['completed', 'TOURNAMENT_COMPLETED'],
  ] as const)('Given %s player, when dispatching a tool, then returns %s before forwarding', async (terminalState, code) => {
    const response = await dispatchToolCall('player-1', toolRequest(), makeEnv(terminalState));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: {
        code,
        message:
          terminalState === 'eliminated'
            ? 'Tournament player is eliminated'
            : 'Tournament is completed',
        tournamentId: 'lobby:terminal-lobby',
      },
    });
  });

  it.each([
    'eliminated',
    'completed',
  ] as const)('Given %s session, when opening /ws/player, then terminal 409 returns without DO forwarding', async (terminalState) => {
    const { env, forwarded } = terminalNamespaces();
    const database = env.DB as unknown as {
      prepare: (sql: string) => { bind: (playerId: string) => { first: () => Promise<unknown> } };
    };
    const originalPrepare = database.prepare;
    database.prepare = (_sql) => ({
      bind: (_playerId) => ({
        first: async () => ({
          lobby_id: 'terminal-lobby',
          game_id: 'terminal-game',
          game_type: 'tragedy-of-the-commons',
          terminal_state: terminalState,
        }),
      }),
    });

    const response = await worker.fetch(
      new Request('https://worker/ws/player?ticket=valid', { headers: { Upgrade: 'websocket' } }),
      env,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ status: terminalState });
    expect(forwarded).toEqual({ lobby: 0, game: 0 });
    database.prepare = originalPrepare;
  });
});
