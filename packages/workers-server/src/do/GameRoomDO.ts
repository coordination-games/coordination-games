import { DurableObject } from 'cloudflare:workers';

export class GameRoomDO extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    return new Response('Not implemented', { status: 501 });
  }
}
