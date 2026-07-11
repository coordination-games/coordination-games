import { DurableObject } from 'cloudflare:workers';
import {
  applyTournamentPayouts,
  type Bytes32Hex,
  computeHorizonCommitment,
  createHiddenHorizonPublicConfig,
  createSeries,
  createTournamentEconomics,
  deriveTournamentGameSeed,
  deriveTournamentHorizonSecret,
  deriveTournamentRoomName,
  getGame,
  onGameSettled,
  parseBytes32Hex,
  type TournamentEconomics,
  type TournamentSeries,
} from '@coordination-games/engine';
import { z } from 'zod';
import { createRelay } from '../chain/index.js';
import type { Env } from '../env.js';

const STATE_KEY = 'tournament:runtime:v1';
const TICK_DELAY_MS = 5_000;
const TRAGEDY_GAME_TYPE = 'tragedy-of-the-commons';
const policySchema = z
  .object({
    seriesLength: z.number().int().min(1),
    baseEntryCost: z
      .string()
      .regex(/^(0|[1-9][0-9]*)$/)
      .transform(BigInt),
    carryBps: z.number().int().min(0).max(10_000),
    slashBps: z.number().int().min(0).max(10_000),
    minRounds: z.number().int().min(1),
    maxRounds: z.number().int().min(1).max(65_535),
    hazardNumerator: z.number().int().min(0),
    hazardDenominator: z.number().int().min(1),
  })
  .strict()
  .refine((policy) => policy.hazardNumerator <= policy.hazardDenominator, {
    message: 'hazardNumerator must not exceed hazardDenominator',
  });
const createSchema = z
  .object({
    tournamentId: z.string().min(1),
    gameType: z.literal(TRAGEDY_GAME_TYPE),
    playerEntries: z
      .array(z.object({ id: z.string().min(1), handle: z.string().min(1) }).strict())
      .min(2),
    policy: policySchema,
    tournamentRootSeed: z.string(),
    playerEntropy: z.string(),
    disabledPlugins: z.array(z.string()).optional(),
  })
  .strict();

type PlayerEntry = { readonly id: string; readonly handle: string };
type RuntimeState = {
  readonly version: 1;
  readonly series: TournamentSeries;
  readonly playerEntries: readonly PlayerEntry[];
  readonly playerEntropy: Bytes32Hex;
  readonly disabledPlugins: readonly string[];
  readonly currentGameId: string | null;
  readonly currentGameIndex: number | null;
  readonly gameIds: readonly string[];
  readonly processedGameIds: readonly string[];
  readonly phase: 'spawning' | 'creating_game' | 'awaiting_settlement';
  readonly status: 'running' | 'completed' | 'failed';
  readonly error: string | null;
};

function serializeEconomics(economics: TournamentEconomics): Record<string, string | number> {
  return {
    baseEntryCost: economics.baseEntryCost.toString(),
    entryCost: economics.entryCost.toString(),
    playerCount: economics.playerCount,
    basePot: economics.basePot.toString(),
    incomingCarry: economics.incomingCarry.toString(),
    releasedCarry: economics.releasedCarry.toString(),
    carryRemainder: economics.carryRemainder.toString(),
    carry: economics.carry.toString(),
    slash: economics.slash.toString(),
    treasuryDelta: economics.treasuryDelta.toString(),
  };
}

function publicState(state: RuntimeState): object {
  return {
    tournamentId: state.series.tournamentId,
    gameType: state.series.gameType,
    standings: state.series.standings.map((standing) => ({
      ...standing,
      cumulativeDelta: standing.cumulativeDelta.toString(),
    })),
    activePlayerIds: state.series.activePlayerIds,
    eliminatedPlayerIds: state.series.playerIds.filter(
      (id) => !state.series.activePlayerIds.includes(id),
    ),
    currentGameId: state.currentGameId,
    currentGameIndex: state.currentGameIndex,
    gameIds: state.gameIds,
    status: state.status,
    ...(state.error === null ? {} : { error: state.error }),
  };
}

export class TournamentDO extends DurableObject<Env> {
  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method === 'POST' && path === '/') return this.create(request);
    if (request.method === 'GET' && path === '/state') return this.state();
    if (request.method === 'POST' && path === '/tick') return this.tick();
    return new Response('Not found', { status: 404 });
  }

  async alarm(): Promise<void> {
    await this.advance();
  }

  private async create(request: Request): Promise<Response> {
    if (await this.load())
      return Response.json({ error: 'Tournament already created' }, { status: 409 });
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: 'Invalid tournament create request' }, { status: 400 });
    }
    const parsed = createSchema.safeParse(body);
    if (!parsed.success)
      return Response.json({ error: 'Invalid tournament create request' }, { status: 400 });
    if (parsed.data.tournamentId !== this.ctx.id.name) {
      return Response.json(
        { error: 'Tournament id must match Durable Object name' },
        { status: 400 },
      );
    }
    if (
      new Set(parsed.data.playerEntries.map((player) => player.id)).size !==
      parsed.data.playerEntries.length
    ) {
      return Response.json({ error: 'Duplicate player entries' }, { status: 400 });
    }
    if (
      new Set(parsed.data.playerEntries.map((player) => player.handle)).size !==
      parsed.data.playerEntries.length
    ) {
      return Response.json({ error: 'Duplicate player handles' }, { status: 400 });
    }
    try {
      const root = parseBytes32Hex(parsed.data.tournamentRootSeed, 'tournamentRootSeed');
      const entropy = parseBytes32Hex(parsed.data.playerEntropy, 'playerEntropy');
      const { series } = createSeries(
        {
          tournamentId: parsed.data.tournamentId,
          gameType: parsed.data.gameType,
          playerIds: parsed.data.playerEntries.map((p) => p.id),
          policy: parsed.data.policy,
        },
        root,
      );
      await this.save({
        version: 1,
        series,
        playerEntries: parsed.data.playerEntries,
        playerEntropy: entropy,
        disabledPlugins: parsed.data.disabledPlugins ?? [],
        currentGameId: null,
        currentGameIndex: 0,
        gameIds: [],
        processedGameIds: [],
        phase: 'spawning',
        status: 'running',
        error: null,
      });
      await this.spawn();
      const created = await this.load();
      if (!created) return Response.json({ error: 'Tournament creation failed' }, { status: 500 });
      return Response.json(publicState(created), {
        status: created.status === 'failed' ? 500 : 201,
      });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : 'Tournament creation failed' },
        { status: 400 },
      );
    }
  }

  private async state(): Promise<Response> {
    const runtime = await this.load();
    return runtime
      ? Response.json(publicState(runtime))
      : Response.json({ error: 'Tournament not found' }, { status: 404 });
  }

  private async tick(): Promise<Response> {
    await this.advance();
    return Response.json(await this.requirePublic());
  }

  private async advance(): Promise<void> {
    const runtime = await this.load();
    if (!runtime || runtime.status !== 'running') return;
    if (runtime.phase === 'spawning' || runtime.phase === 'creating_game') return this.spawn();
    const gameId = runtime.currentGameId;
    if (gameId === null || runtime.processedGameIds.includes(gameId)) return;
    const room = this.env.GAME_ROOM.get(this.env.GAME_ROOM.idFromName(gameId));
    await this.reschedule();
    let result: Response;
    try {
      result = await room.fetch(new Request('https://game/result'));
    } catch {
      return;
    }
    if (result.status === 409) return this.reschedule();
    if (!result.ok) return this.fail(`Game result failed: ${result.status}`);
    let settlement: Response;
    try {
      settlement = await room.fetch(new Request('https://game/settlement-status'));
    } catch {
      return;
    }
    if (!settlement.ok) return this.fail(`Settlement status failed: ${settlement.status}`);
    let body: {
      readonly state?: { readonly kind?: string } | null;
    };
    let resultBody: { readonly outcome: unknown };
    try {
      body = (await settlement.json()) as typeof body;
      resultBody = (await result.json()) as typeof resultBody;
    } catch {
      return;
    }
    if (body.state?.kind === 'failed') return this.fail('Game settlement failed');
    if (body.state?.kind !== 'confirmed') return this.reschedule();
    const plugin = getGame(runtime.series.gameType);
    if (!plugin?.computePayouts) return this.fail('Game plugin cannot compute payouts');
    const economics = createTournamentEconomics({
      policy: runtime.series.policy,
      playerCount: runtime.series.activePlayerIds.length,
      incomingCarry: runtime.series.treasuryCarry,
    });
    const payouts = applyTournamentPayouts(
      plugin.computePayouts(
        resultBody.outcome,
        [...runtime.series.activePlayerIds],
        economics.entryCost,
      ),
      runtime.series.activePlayerIds,
      economics,
    ).playerPayouts;
    const nextTreasuryCarry = economics.carryRemainder + economics.carry;
    const eliminated = await this.insolvent(runtime, nextTreasuryCarry);
    const settled = onGameSettled(
      runtime.series,
      { gameId, gameIndex: runtime.currentGameIndex ?? runtime.series.currentGameIndex },
      payouts,
      eliminated,
    );
    if (settled.nextGameConfig !== null && settled.series.activePlayerIds.length >= 2) {
      const expectedNextEntryCost = createTournamentEconomics({
        policy: runtime.series.policy,
        playerCount: settled.series.activePlayerIds.length,
        incomingCarry: nextTreasuryCarry,
      }).entryCost;
      if (settled.nextGameConfig.entryCost !== expectedNextEntryCost) {
        return this.fail('Next game entry cost disagrees with survivor eligibility threshold');
      }
    }
    const updated: RuntimeState = {
      ...runtime,
      series: settled.series,
      processedGameIds: [...runtime.processedGameIds, gameId],
      currentGameId: null,
      currentGameIndex: settled.series.currentGameIndex,
      phase: 'spawning',
    };
    await this.save(updated);
    await this.reschedule();
    if (
      settled.series.currentGameIndex >= settled.series.policy.seriesLength ||
      settled.series.activePlayerIds.length < 2
    ) {
      await this.save({ ...updated, status: 'completed' });
      return;
    }
    await this.spawn();
  }

  private async spawn(): Promise<void> {
    const runtime = await this.load();
    if (!runtime || runtime.status !== 'running') return;
    if (runtime.currentGameId !== null && runtime.phase !== 'creating_game') return;
    const index = runtime.currentGameIndex ?? runtime.series.currentGameIndex;
    const gameId =
      runtime.currentGameId ?? deriveTournamentRoomName(runtime.series.tournamentId, index);
    const secret = deriveTournamentHorizonSecret(
      runtime.series.tournamentRootSeed,
      runtime.series.tournamentId,
      index,
    );
    const commitment = computeHorizonCommitment({
      secret,
      gameId,
      playerEntropy: runtime.playerEntropy,
      policyHash: runtime.series.policyHash,
    });
    const plugin = getGame(runtime.series.gameType);
    if (!plugin?.createConfig) return this.fail('Game plugin does not implement createConfig');
    const players = runtime.playerEntries.filter((player) =>
      runtime.series.activePlayerIds.includes(player.id),
    );
    const economics = createTournamentEconomics({
      policy: runtime.series.policy,
      playerCount: players.length,
      incomingCarry: runtime.series.treasuryCarry,
    });
    try {
      const gameSeed = deriveTournamentGameSeed(
        runtime.series.tournamentRootSeed,
        runtime.series.tournamentId,
        index,
      );
      const setup = plugin.createConfig(players, gameSeed, {
        maxRounds: runtime.series.policy.maxRounds,
      });
      if (
        setup.players.map((player) => player.id).join('\u0000') !==
        players.map((player) => player.id).join('\u0000')
      )
        return this.fail('Plugin changed active player IDs');
      if (typeof setup.config !== 'object' || setup.config === null || Array.isArray(setup.config))
        return this.fail('Plugin config must be an object');
      const config = {
        ...setup.config,
        maxRounds: runtime.series.policy.maxRounds,
        tournamentEconomics: serializeEconomics(economics),
        hiddenHorizon: createHiddenHorizonPublicConfig(commitment, runtime.series.policy),
      };
      const next = {
        ...runtime,
        currentGameId: gameId,
        currentGameIndex: index,
        gameIds: runtime.gameIds.includes(gameId) ? runtime.gameIds : [...runtime.gameIds, gameId],
        phase: 'creating_game' as const,
      };
      await this.save(next);
      await this.reschedule();
      const room = this.env.GAME_ROOM.get(this.env.GAME_ROOM.idFromName(gameId));
      const create = await room.fetch(
        new Request('https://game/', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            gameId,
            gameType: runtime.series.gameType,
            config,
            playerIds: players.map((p) => p.id),
            handleMap: Object.fromEntries(players.map((p) => [p.id, p.handle])),
            teamMap: Object.fromEntries(setup.players.map((p) => [p.id, p.team])),
            disabledPlugins: runtime.disabledPlugins,
            tournamentCommitContext: {
              tournamentRootSeed: runtime.series.tournamentRootSeed,
              gameSeed,
              tournamentId: runtime.series.tournamentId,
              gameIndex: index,
              policy: {
                ...runtime.series.policy,
                baseEntryCost: runtime.series.policy.baseEntryCost.toString(),
              },
              economics: serializeEconomics(economics),
              horizonSecret: secret,
              playerEntropy: runtime.playerEntropy,
            },
          }),
        }),
      );
      if (!create.ok && create.status !== 409)
        return this.fail(`Game create failed: ${create.status}`);
      await this.saveGameRow(gameId, runtime.series.gameType);
      await this.reschedule();
      const start = await room.fetch(
        new Request('https://game/action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: { type: 'game_start' } }),
        }),
      );
      if (!start.ok && start.status !== 409) return this.fail(`Game start failed: ${start.status}`);
      await this.save({ ...next, phase: 'awaiting_settlement' });
      await this.reschedule();
    } catch (error) {
      await this.fail(error instanceof Error ? error.message : 'Game spawn failed');
    }
  }

  private async insolvent(
    runtime: RuntimeState,
    nextTreasuryCarry: bigint,
  ): Promise<readonly string[]> {
    const balances = new Map<string, bigint>();
    for (const playerId of runtime.series.activePlayerIds) {
      const row = await this.env.DB.prepare('SELECT chain_agent_id FROM players WHERE id = ?')
        .bind(playerId)
        .first<{ chain_agent_id: number | null }>();
      if (row === null || row.chain_agent_id === null)
        throw new Error(`Player ${playerId} has no chain agent`);
      const credits = await this.getPlayerCredits(row.chain_agent_id.toString());
      if (!/^(0|[1-9][0-9]*)$/.test(credits))
        throw new Error(`Player ${playerId} returned invalid credits`);
      balances.set(playerId, BigInt(credits));
    }
    let survivors = [...runtime.series.activePlayerIds];
    while (survivors.length >= 2) {
      const nextEntryCost = createTournamentEconomics({
        policy: runtime.series.policy,
        playerCount: survivors.length,
        incomingCarry: nextTreasuryCarry,
      }).entryCost;
      const eligible = survivors.filter((playerId) => {
        const balance = balances.get(playerId);
        if (balance === undefined) throw new Error(`Player ${playerId} has no loaded balance`);
        return balance >= nextEntryCost;
      });
      if (eligible.length === survivors.length) break;
      survivors = eligible;
    }
    return runtime.series.activePlayerIds.filter((playerId) => !survivors.includes(playerId));
  }
  protected async getPlayerCredits(agentId: string): Promise<string> {
    return (await createRelay(this.env).getBalance(agentId)).credits;
  }

  private async reschedule(): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now() + TICK_DELAY_MS);
  }
  private async fail(error: string): Promise<void> {
    const state = await this.load();
    if (state) await this.save({ ...state, status: 'failed', error });
  }
  private async saveGameRow(gameId: string, gameType: string): Promise<void> {
    await this.env.DB.prepare(
      'INSERT OR IGNORE INTO games (game_id, game_type, finished, created_at) VALUES (?, ?, 0, ?)',
    )
      .bind(gameId, gameType, new Date().toISOString())
      .run();
  }
  private async load(): Promise<RuntimeState | null> {
    return (await this.ctx.storage.get<RuntimeState>(STATE_KEY)) ?? null;
  }
  private async save(state: RuntimeState): Promise<void> {
    await this.ctx.storage.put(STATE_KEY, state);
  }
  private async requirePublic(): Promise<object> {
    const state = await this.load();
    return state ? publicState(state) : { error: 'Tournament not found' };
  }
}
