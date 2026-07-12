import { CTL_DEFAULT_TEAM_SIZE, CTL_GAME_ID } from '@coordination-games/game-ctl';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { makeMemoryStorage, readJson } from './test-helpers.js';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {},
}));

type LobbyDOModule = typeof import('../do/LobbyDO.js');
let LobbyDO: LobbyDOModule['LobbyDO'];

beforeAll(async () => {
  ({ LobbyDO } = await import('../do/LobbyDO.js'));
});

function directCreateRequest(body: Record<string, unknown>): Request {
  return new Request('https://do/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function makeDirectLobby(): {
  readonly lobby: InstanceType<typeof LobbyDO>;
  readonly storage: ReturnType<typeof makeMemoryStorage>;
} {
  const storage = makeMemoryStorage();
  const lobby = Object.create(LobbyDO.prototype) as InstanceType<typeof LobbyDO>;
  Reflect.set(lobby, '_loaded', true);
  Reflect.set(lobby, '_meta', null);
  Reflect.set(lobby, '_agents', []);
  Reflect.set(lobby, '_phaseState', null);
  Reflect.set(lobby, '_stateVersion', 0);
  Reflect.set(lobby, 'ctx', {
    storage,
    getWebSockets: () => [] as WebSocket[],
    id: { name: 'direct-create' },
  });
  Reflect.set(lobby, 'env', { DB: {} });
  return { lobby, storage };
}

describe('LobbyDO direct create size boundary', () => {
  it.each([
    1,
    7,
    2.5,
    '2',
    null,
  ])('returns 400 for unsupported direct CTL size %s without persisting state', async (teamSize) => {
    // Given
    const fixture = makeDirectLobby();

    // When
    const response = await fixture.lobby.fetch(
      directCreateRequest({ lobbyId: 'direct-create', gameType: CTL_GAME_ID, teamSize }),
    );

    // Then
    expect(response.status).toBe(400);
    expect((await readJson(response)).error).toMatch(/team-size.*2.*6/i);
    expect(fixture.storage._raw.size).toBe(0);
    expect(Reflect.get(fixture.lobby, '_meta')).toBeNull();
  });

  it('persists the CTL policy default for a direct create with omitted size', async () => {
    // Given
    const fixture = makeDirectLobby();

    // When
    const response = await fixture.lobby.fetch(
      directCreateRequest({ lobbyId: 'direct-create', gameType: CTL_GAME_ID }),
    );

    // Then
    expect(response.status).toBe(200);
    expect(fixture.storage._raw.get('phaseState')).toMatchObject({
      teamSize: CTL_DEFAULT_TEAM_SIZE,
      numTeams: 2,
    });
  });
});
