import { GameRoomDO } from './do/GameRoomDO';
import { LobbyDO } from './do/LobbyDO';

// Re-export DO classes — required for Durable Object bindings to work
export { GameRoomDO, LobbyDO };

const GIT_SHA = 'c354d7f';

interface Env {
  DB: D1Database;
  GAME_ROOM: DurableObjectNamespace;
  LOBBY: DurableObjectNamespace;
  ENVIRONMENT: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname === '/health') {
      return Response.json({ ok: true, build: GIT_SHA });
    }

    if (pathname === '/') {
      return Response.redirect(new URL('/health', request.url).toString(), 302);
    }

    return new Response('Not found', { status: 404 });
  },
};
