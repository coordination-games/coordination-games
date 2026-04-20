#!/usr/bin/env tsx
// Ad-hoc: heal sessions by re-joining each bot to the target lobby, then
// spawn claude agents to drive them.
import { api, authenticate, loadPool, runClaudeAgent } from './lib/bot-agent.js';

async function main() {
  const SERVER = process.env.GAME_SERVER ?? 'https://api.capturethelobster.com';
  const LOBBY_ID = process.env.LOBBY_ID ?? 'd1f9e2a7-7d23-4beb-b61b-e443aefd751e';
  const bots = (await loadPool()).slice(0, 3);
  console.log(`Driving ${bots.length} bots for lobby ${LOBBY_ID.slice(0, 8)} on ${SERVER}...\n`);

  // Heal stale sessions: re-auth + re-join (idempotent if already member).
  for (const b of bots) {
    try {
      const { token } = await authenticate(SERVER, b.privateKey, b.name);
      await api(SERVER, '/api/player/lobby/join', {
        method: 'POST',
        token,
        body: { lobbyId: LOBBY_ID },
      });
      console.log(`  ${b.name} re-joined`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  ${b.name} re-join failed: ${msg}`);
    }
  }
  console.log();

  await Promise.all(
    bots.map((b) =>
      runClaudeAgent({
        server: SERVER,
        botName: b.name,
        privateKey: b.privateKey,
        gameType: 'capture-the-lobster',
        model: 'haiku',
      }),
    ),
  );
  console.log('\nAll done.');
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
