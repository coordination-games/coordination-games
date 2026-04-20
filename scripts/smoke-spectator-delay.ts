#!/usr/bin/env tsx
/**
 * smoke-spectator-delay.ts — End-to-end verification that the spectator
 * delay boundary is enforced on the server. Run against `wrangler dev`
 * (or any deployed server) via:
 *
 *   GAME_SERVER=http://localhost:8787 tsx scripts/smoke-spectator-delay.ts
 *
 * Scenarios T1–T10 map 1-to-1 to docs/plans/spectator-delay-security-fix.md
 * §6.2. Each scenario asserts one invariant and exits non-zero on failure.
 *
 * Requirements against the server under test:
 *   - Capture the Lobster is registered with spectatorDelay = 2.
 *   - Authentication accepts an EIP-191 signed challenge (see
 *     scripts/test-ctl-moves.ts for the pattern this script mirrors).
 *   - The server has a D1 binding with the standard schema.
 */

import { ethers } from 'ethers';
import { api as libApi, authenticate as libAuth } from './lib/bot-agent.js';

const SERVER = process.env.GAME_SERVER ?? 'http://localhost:8787';
const TEAM_SIZE = 2;
const BOT_COUNT = TEAM_SIZE * 2;

type Bot = {
  wallet: ethers.Wallet;
  name: string;
  token: string;
  playerId: string;
};

// ---------------------------------------------------------------------------
// Thin wrappers over scripts/lib/bot-agent.ts — apiOk reuses the throwing
// helper; apiRaw captures non-2xx for the T5 403 assertions.
// ---------------------------------------------------------------------------

const apiOk = (path: string, opts: { method?: string; body?: unknown; token?: string } = {}) =>
  libApi(SERVER, path, opts);

async function apiRaw(
  path: string,
  opts: { method?: string; body?: unknown; token?: string } = {},
  // biome-ignore lint/suspicious/noExplicitAny: dev smoke-test wrapper; callers walk parsed JSON with loose property access and narrowing at every site would duplicate the server's D1/DO response shapes here.
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${SERVER}${path}`, {
    method: opts.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  // biome-ignore lint/suspicious/noExplicitAny: see api() return type.
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = { _raw: text };
  }
  return { status: res.status, body: json };
}

const authenticate = (wallet: ethers.Wallet, name: string) =>
  libAuth(SERVER, wallet.privateKey, name).then(({ token, playerId }) => ({ token, playerId }));

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Assertion helpers — collect failures, print at end
// ---------------------------------------------------------------------------

const failures: string[] = [];
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  ✓ ${label}`);
  } else {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
  }
}

// ---------------------------------------------------------------------------
// Game setup
// ---------------------------------------------------------------------------

async function setupGame(): Promise<{ bots: Bot[]; lobbyId: string; gameId: string }> {
  console.log(`\n== Setup: ${BOT_COUNT} bots, CtL lobby, ${SERVER}`);
  const wallets = Array.from({ length: BOT_COUNT }, () => ethers.Wallet.createRandom());
  const bots: Bot[] = await Promise.all(
    wallets.map(async (wallet, i) => {
      const name = `smoke${i + 1}-${wallet.address.slice(2, 8)}`;
      const { token, playerId } = await authenticate(wallet, name);
      return { wallet, name, token, playerId };
    }),
  );

  const lobby = await apiOk('/api/lobbies/create', {
    method: 'POST',
    token: bots[0].token,
    body: { gameType: 'capture-the-lobster', teamSize: TEAM_SIZE, noTimeout: true },
  });
  await Promise.all(
    bots.map((bot) =>
      apiOk('/api/player/lobby/join', {
        method: 'POST',
        token: bot.token,
        body: { lobbyId: lobby.lobbyId },
      }),
    ),
  );

  // Team formation
  const teams = [bots.slice(0, TEAM_SIZE), bots.slice(TEAM_SIZE)];
  for (const team of teams) {
    for (let i = 1; i < team.length; i++) {
      await apiOk('/api/player/tool', {
        method: 'POST',
        token: team[0].token,
        body: { toolName: 'propose_team', args: { targetHandle: team[i].name } },
      });
      const state = await apiOk('/api/player/state', { token: team[0].token });
      const phaseTeams = state.currentPhase?.view?.teams ?? [];
      const proposerTeam = phaseTeams.find((t: { members: string[] }) =>
        t.members.includes(team[0].playerId),
      );
      await apiOk('/api/player/tool', {
        method: 'POST',
        token: team[i].token,
        body: { toolName: 'accept_team', args: { teamId: proposerTeam?.id } },
      });
    }
  }

  // Wait for class-selection phase
  for (let i = 0; i < 60; i++) {
    const state = await apiOk('/api/player/state', { token: bots[0].token }).catch(() => null);
    if (state?.currentPhase?.id === 'class-selection' || state?.phase === 'game') break;
    await sleep(500);
  }

  // Choose classes
  const CLASSES = ['rogue', 'knight'];
  await Promise.all(
    bots.map((bot, i) =>
      apiOk('/api/player/tool', {
        method: 'POST',
        token: bot.token,
        body: { toolName: 'choose_class', args: { unitClass: CLASSES[i % TEAM_SIZE] } },
      }),
    ),
  );

  // Wait for game start; resolve the gameId
  let gameId: string | null = null;
  for (let i = 0; i < 60; i++) {
    const lobbyState = await apiOk(`/api/lobbies/${lobby.lobbyId}`).catch(() => null);
    if (lobbyState?.gameId) {
      gameId = lobbyState.gameId;
      break;
    }
    await sleep(500);
  }
  if (!gameId) throw new Error('Game never started');

  console.log(`   lobbyId=${lobby.lobbyId} gameId=${gameId}`);
  return { bots, lobbyId: lobby.lobbyId, gameId };
}

// ---------------------------------------------------------------------------
// Progress the game by having every bot submit STAY
// ---------------------------------------------------------------------------

async function advanceTurn(bots: Bot[]): Promise<void> {
  for (const bot of bots) {
    await apiRaw('/api/player/tool', {
      method: 'POST',
      token: bot.token,
      body: { toolName: 'move', args: { path: [] } },
    });
  }
  // Give the progress tick a moment to land before the next read
  await sleep(400);
}

async function currentTurn(bot: Bot): Promise<number> {
  const state = await apiOk('/api/player/state', { token: bot.token });
  return state.turn ?? 0;
}

async function sendTeamChat(bot: Bot, message: string): Promise<void> {
  await apiRaw('/api/player/tool', {
    method: 'POST',
    token: bot.token,
    body: { toolName: 'team_chat', args: { message } },
  });
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

async function runScenarios(): Promise<void> {
  const { bots, gameId } = await setupGame();
  const teamA = bots.slice(0, TEAM_SIZE);
  const teamB = bots.slice(TEAM_SIZE);

  // T2 — pre-window: immediately after creation, /spectator should be pending
  console.log('\n== T2: pre-window /spectator returns spectator_pending');
  const t2 = await apiOk(`/api/games/${gameId}/spectator`);
  check('T2.type=spectator_pending', t2?.type === 'spectator_pending', `got type=${t2?.type}`);
  check(
    'T2.no tiles field',
    !('tiles' in (t2 ?? {})),
    'spectator_pending should not include tiles',
  );

  // Drive through enough ticks that the spectator view has caught up
  console.log('\n== Driving game forward to tick 5');
  let lastTurn = 0;
  for (let i = 0; i < 30 && lastTurn < 5; i++) {
    await advanceTurn(bots);
    lastTurn = await currentTurn(bots[0]);
  }

  // T1 — spectator reflects index (length - 1 - 2), chat present
  console.log(`\n== T1: /spectator is 2 turns behind at internal turn ${lastTurn}`);
  await sendTeamChat(teamA[0], 'hello from A');
  await sendTeamChat(teamB[0], 'hello from B');
  // Advance two turns so the chat is baked into a delayed snapshot
  for (let i = 0; i < 3; i++) {
    await advanceTurn(bots);
    lastTurn = await currentTurn(bots[0]);
  }
  const t1 = await apiOk(`/api/games/${gameId}/spectator`);
  check('T1.type=state_update', t1?.type === 'state_update', `got type=${t1?.type}`);
  const pubTurn = t1?.turn ?? -1;
  check('T1.delay>=2', pubTurn <= lastTurn - 2, `publicTurn=${pubTurn}, internal=${lastTurn}`);
  const chatAHasMsg = (t1?.chatA ?? []).some((m: { message?: string }) =>
    (m.message ?? '').includes('hello from A'),
  );
  const chatBHasMsg = (t1?.chatB ?? []).some((m: { message?: string }) =>
    (m.message ?? '').includes('hello from B'),
  );
  check('T1.chatA present in delayed snapshot', chatAHasMsg);
  check('T1.chatB present in delayed snapshot', chatBHasMsg);

  // T3 — /replay returns truncated snapshots without `relay`
  console.log('\n== T3: /replay truncated, no raw relay');
  const t3 = await apiOk(`/api/games/${gameId}/replay`);
  check('T3.type=replay', t3?.type === 'replay', `got type=${t3?.type}`);
  check('T3.no relay field', !('relay' in (t3 ?? {})), 'relay field must be removed');
  const snapshots: unknown[] = t3?.snapshots ?? [];
  check(
    'T3.snapshots count <= internal+1',
    snapshots.length <= lastTurn + 1,
    `snapshots=${snapshots.length}, internal=${lastTurn}`,
  );
  check(
    'T3.last snapshot turn <= internal-2',
    snapshots.length > 0 && (snapshots[snapshots.length - 1]?.turn ?? 999) <= lastTurn - 2,
    `lastTurn=${snapshots[snapshots.length - 1]?.turn}`,
  );

  // T4 — cross-team chat leak: message emitted at current tick is NOT in chatB yet
  console.log('\n== T4: new team-B message not in chatB until delay elapses');
  const marker = `t4-${Date.now()}`;
  await sendTeamChat(teamB[0], marker);
  const t4Before = await apiOk(`/api/games/${gameId}/spectator`);
  const leakedEarly = (t4Before?.chatB ?? []).some((m: { message?: string }) =>
    (m.message ?? '').includes(marker),
  );
  check('T4.marker not in spectator chatB within delay window', !leakedEarly);
  // Advance 3 turns to age the message out of the delay window
  for (let i = 0; i < 3; i++) await advanceTurn(bots);
  const t4After = await apiOk(`/api/games/${gameId}/spectator`);
  const revealed = (t4After?.chatB ?? []).some((m: { message?: string }) =>
    (m.message ?? '').includes(marker),
  );
  check('T4.marker revealed in spectator chatB after delay', revealed);

  // T5 — state?playerId=<victim> must not return victim's private state
  console.log('\n== T5: /state?playerId=<X> never returns X private state to Y');
  const victim = teamA[0];
  const attacker = teamB[0];
  const r5 = await apiRaw(
    `/api/games/${gameId}/state?playerId=${encodeURIComponent(victim.playerId)}`,
    { token: attacker.token },
  );
  // Post-fix behaviour: the query param is ignored; the DO sees X-Player-Id=attacker
  // and returns attacker's own state (same-game, so 200) — but units should reflect
  // attacker's team, not victim's. A 403 is also acceptable.
  if (r5.status === 403) {
    check('T5.forbidden or owned-state', true);
  } else {
    check('T5.status 200', r5.status === 200, `status=${r5.status}`);
    // attacker is team B; check that units list includes attacker
    const hasAttacker = (r5.body?.units ?? []).some(
      (u: { id: string }) => u.id === attacker.playerId,
    );
    check(
      'T5.returned state belongs to caller, not victim',
      hasAttacker,
      `units=${JSON.stringify((r5.body?.units ?? []).map((u: { id: string }) => u.id))}`,
    );
  }
  // Attempt with a completely unrelated wallet (not in game)
  const outsiderWallet = ethers.Wallet.createRandom();
  const outsider = await authenticate(
    outsiderWallet,
    `outsider-${outsiderWallet.address.slice(2, 8)}`,
  );
  const r5b = await apiRaw(
    `/api/games/${gameId}/state?playerId=${encodeURIComponent(victim.playerId)}`,
    { token: outsider.token },
  );
  check('T5.outsider denied', r5b.status === 403, `status=${r5b.status}`);

  // T6 — /api/games summary uses public snapshot
  console.log('\n== T6: /api/games summary progressCounter is delayed');
  const t6 = await apiOk('/api/games');
  const row = (t6 as Array<{ gameId: string }>).find((g) => g.gameId === gameId);
  check('T6.row present', !!row);
  if (row) {
    check(
      'T6.progressCounter <= internal-2',
      (row.progressCounter ?? 0) <= lastTurn - 2,
      `summary=${row.progressCounter}, internal=${lastTurn}`,
    );
  }

  // T7 — player WS receives own-team chat (via REST poll as a stand-in for WS
  // — the server's buildPlayerMessage is the same code path). Team A bot
  // should see marker-A in its chat immediately after send.
  console.log('\n== T7: team-A player sees own-team chat immediately');
  const markerA = `t7-${Date.now()}`;
  await sendTeamChat(teamA[0], markerA);
  await sleep(200);
  const t7State = await apiOk('/api/player/state', { token: teamA[1].token });
  const t7Seen = (t7State.relayMessages ?? []).some(
    (m: { data?: { body?: string; message?: string } }) =>
      (m.data?.body ?? '').includes(markerA) || (m.data?.message ?? '').includes(markerA),
  );
  check('T7.team-A ally sees markerA', t7Seen);

  // T8 — opposing-team isolation: team B must not see marker-A
  const t8State = await apiOk('/api/player/state', { token: teamB[0].token });
  const t8Seen = (t8State.relayMessages ?? []).some(
    (m: { data?: { body?: string; message?: string } }) =>
      (m.data?.body ?? '').includes(markerA) || (m.data?.message ?? '').includes(markerA),
  );
  check('T8.team-B does NOT see markerA', !t8Seen);

  // T9 + T10 require a finished game / reconnect — documented here but skipped
  // in the minimal script. Drive the game to completion if you need T9.
  console.log('\n== T9/T10 skipped in smoke — see plan §6.2 for manual runs');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`smoke-spectator-delay against ${SERVER}`);
  try {
    await runScenarios();
  } catch (err) {
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error('\nFatal during scenarios:', detail);
    process.exit(2);
  }

  console.log('\n==================== Summary ====================');
  if (failures.length === 0) {
    console.log('All checks passed.');
    process.exit(0);
  } else {
    console.log(`${failures.length} FAILURE(S):`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
