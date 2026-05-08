#!/usr/bin/env tsx
const SERVER = 'http://127.0.0.1:3101';

async function adminApi(path: string) {
  console.log(`adminApi: ${path}`);
  const res = await fetch(`${SERVER}${path}`, {
    headers: { 'X-Admin-Token': 'local-inspector-token' },
  });
  console.log(`adminApi: ${path} status=${res.status}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(JSON.stringify(data));
  return data;
}

async function main() {
  const gameId = 'b5be23b5-6bc2-470d-ac46-5760306cba39';
  console.log('Starting debug loop...');

  for (let i = 0; i < 3; i++) {
    console.log(`Iteration ${i}...`);
    const inspect = await adminApi(`/api/admin/session/${gameId}/inspect`);
    console.log(`Got inspect, keys: ${Object.keys(inspect).join(', ')}`);

    const state = inspect.game?.state || inspect.state;
    console.log(`State type: ${typeof state}`);

    if (state && typeof state === 'object') {
      console.log(
        `Round: ${state.round}, Phase: ${state.phase}, CurrentPlayer: ${state.currentPlayerIndex}`,
      );
    }

    await new Promise((r) => setTimeout(r, 2000));
  }

  console.log('Debug loop complete');
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
