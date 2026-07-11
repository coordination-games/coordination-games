import { getGame, LadderPolicyError } from '@coordination-games/engine';
import '@coordination-games/game-ctl';
import '@coordination-games/game-oathbreaker';
import '@coordination-games/game-tragedy-of-the-commons';
import {
  type LadderReplayEvidence,
  parseLadderReplayBundle,
  ReplayBundleValidationError,
  ReplayBundleVerificationError,
} from './admin-ladder-bundle.js';
import type { Env } from './env.js';
import {
  LadderPersistenceError,
  LadderReplayConflictError,
  recordReplayLadderMatch,
} from './plugins/elo/ladder-service.js';

function adminAuth(request: Request, env: Env): Response | null {
  const expected = env.ADMIN_TOKEN;
  if (!expected) {
    return Response.json(
      { error: 'Admin endpoint disabled (ADMIN_TOKEN not set)' },
      { status: 503 },
    );
  }
  if (request.headers.get('X-Admin-Token') !== expected) {
    return Response.json({ error: 'Invalid admin token' }, { status: 401 });
  }
  return null;
}

function gameRoom(env: Env, gameId: string): DurableObjectStub {
  return env.GAME_ROOM.get(env.GAME_ROOM.idFromName(gameId));
}

export async function handleAdminLadderReplay(
  request: Request,
  env: Env,
  gameId: string,
): Promise<Response> {
  const authError = adminAuth(request, env);
  if (authError !== null) return authError;

  const bundleResponse = await gameRoom(env, gameId).fetch(
    new Request('https://game-room.invalid/bundle', { method: 'GET' }),
  );
  if (!bundleResponse.ok) {
    return new Response(bundleResponse.body, {
      status: bundleResponse.status,
      headers: bundleResponse.headers,
    });
  }

  let evidence: LadderReplayEvidence;
  try {
    evidence = parseLadderReplayBundle(await bundleResponse.json(), gameId);
  } catch (error) {
    if (error instanceof ReplayBundleValidationError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof ReplayBundleVerificationError) {
      return Response.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }

  const plugin = getGame(evidence.bundle.gameType);
  if (plugin === undefined || plugin.getLadderPlacements === undefined) {
    return Response.json(
      { error: `Game type ${evidence.bundle.gameType} does not expose ladder placements` },
      { status: 400 },
    );
  }

  try {
    const placements = plugin.getLadderPlacements(
      evidence.bundle.result.outcome,
      evidence.bundle.playerIds,
    );
    const receipt = await recordReplayLadderMatch(env.DB, {
      gameId,
      gameType: evidence.bundle.gameType,
      replayHash: evidence.replayHash,
      resultHash: evidence.resultHash,
      placements,
    });
    return Response.json(receipt);
  } catch (error) {
    if (error instanceof LadderReplayConflictError) {
      return Response.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof LadderPolicyError || error instanceof LadderPersistenceError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
}
