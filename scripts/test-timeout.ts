#!/usr/bin/env tsx
import { getMapRadiusForTeamSize } from '../packages/games/capture-the-lobster/src/map.js';
import type { CtlAction } from '../packages/games/capture-the-lobster/src/plugin.js';
import { CaptureTheLobsterPlugin } from '../packages/games/capture-the-lobster/src/plugin.js';

const teamSize = 2;
const radius = getMapRadiusForTeamSize(teamSize);

const players = [
  { id: 'p1', team: 'A' as const, unitClass: 'rogue' as const },
  { id: 'p2', team: 'A' as const, unitClass: 'knight' as const },
  { id: 'p3', team: 'B' as const, unitClass: 'rogue' as const },
  { id: 'p4', team: 'B' as const, unitClass: 'knight' as const },
];

const config = {
  mapSeed: 'test-timeout-combat',
  mapRadius: radius,
  teamSize,
  turnLimit: 30,
  turnTimerSeconds: 30,
  players,
};

let state = CaptureTheLobsterPlugin.createInitialState(config);

// Start game
let result = CaptureTheLobsterPlugin.applyAction(state, null, { type: 'game_start' });
state = result.state;

// Simulate: some bots submit moves, then timeout fires
const directions = ['N', 'NE', 'SE', 'S', 'SW', 'NW'] as const;

for (let i = 0; i < 35; i++) {
  if (state.phase === 'finished') {
    console.log(`Game finished at turn ${state.turn}!`);
    break;
  }

  const alive = state.units.filter((u) => u.alive);
  console.log(
    `Turn ${state.turn}, alive: ${alive.length}, units: ${state.units.map((u) => `${u.id}(${u.alive ? 'A' : 'D'}@${u.position?.q},${u.position?.r})`).join(' ')}`,
  );

  // Some bots submit random moves
  for (const unit of alive.slice(0, 2)) {
    // Only 2 of 4 submit
    const dir = directions[Math.floor(Math.random() * directions.length)];
    const moveAction: CtlAction = { type: 'move', agentId: unit.id, path: [dir] };
    try {
      if (CaptureTheLobsterPlugin.validateAction(state, unit.id, moveAction)) {
        result = CaptureTheLobsterPlugin.applyAction(state, unit.id, moveAction);
        state = result.state;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`CRASH on move for ${unit.id} at turn ${state.turn}:`, msg);
      process.exit(1);
    }
  }

  // Timeout for remaining
  try {
    result = CaptureTheLobsterPlugin.applyAction(state, null, { type: 'turn_timeout' });
    state = result.state;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    console.error(`CRASH on timeout at turn ${state.turn}:`, msg);
    if (stack) console.error(stack);
    console.log(
      'Units:',
      JSON.stringify(
        state.units.map((u) => ({
          id: u.id,
          alive: u.alive,
          pos: u.position,
          respawn: u.respawnTurn,
        })),
        null,
        2,
      ),
    );
    process.exit(1);
  }
}
console.log('Final turn:', state.turn, 'phase:', state.phase);
