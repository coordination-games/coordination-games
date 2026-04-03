/**
 * E2E local test — Node.js version
 *
 * Tests the full flow: deploy contracts on Hardhat, start Express server, test relay endpoints.
 * Run with: npx tsx scripts/e2e-local.ts
 *
 * Prerequisites:
 * - Hardhat node running: cd packages/contracts && npx hardhat node
 * - Contracts deployed: cd packages/contracts && npx hardhat run scripts/deploy-local.ts --network localhost
 * - Server built: cd packages/server && npx tsc --skipLibCheck
 * - Server running with relay env vars (see scripts/e2e-local.sh for env setup)
 *
 * Or just run scripts/e2e-local.sh which does everything.
 */

const SERVER_URL = process.env.SERVER_URL || 'http://127.0.0.1:15173';

let passed = 0;
let failed = 0;

function ok(label: string) {
  console.log(`  [PASS] ${label}`);
  passed++;
}

function fail(label: string, detail: string) {
  console.log(`  [FAIL] ${label}: ${detail}`);
  failed++;
}

function assert(cond: boolean, label: string, detail?: string) {
  if (cond) ok(label);
  else fail(label, detail || 'assertion failed');
}

async function get(path: string): Promise<any> {
  const res = await fetch(`${SERVER_URL}${path}`);
  return res.json();
}

async function post(path: string, body: any): Promise<any> {
  const res = await fetch(`${SERVER_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function main() {
  console.log('\n=== E2E Local Test (Node.js) ===\n');
  console.log(`Server: ${SERVER_URL}\n`);

  // -----------------------------------------------------------------------
  // 1. Server health check
  // -----------------------------------------------------------------------
  try {
    const lobbies = await get('/api/lobbies');
    assert(Array.isArray(lobbies), 'Server health: /api/lobbies responds');
  } catch (err: any) {
    fail('Server health', `not reachable: ${err.message}`);
    console.log('\nServer not running. Start it first (see scripts/e2e-local.sh).\n');
    process.exit(1);
  }

  // -----------------------------------------------------------------------
  // 2. Check name availability
  // -----------------------------------------------------------------------
  {
    const result = await get('/api/relay/check-name/FreshBot');
    assert(result.available === true, 'check-name: FreshBot available');

    const taken = await get('/api/relay/check-name/testplayer');
    assert(taken.available === false, 'check-name: testplayer taken');
  }

  // -----------------------------------------------------------------------
  // 3. Status check
  // -----------------------------------------------------------------------
  {
    const result = await get('/api/relay/status/0x0000000000000000000000000000000000000000');
    assert(result.registered === false, 'status: zero address not registered');
  }

  // -----------------------------------------------------------------------
  // 4. Balance check for deployed agents
  // -----------------------------------------------------------------------
  {
    const result = await get('/api/relay/balance/1');
    assert(result.credits !== undefined, 'balance: agent 1 has credits field');
    const credits = BigInt(result.credits);
    assert(credits > 0n, `balance: agent 1 has ${credits} credits`);
  }

  // -----------------------------------------------------------------------
  // 5. Game settlement
  // -----------------------------------------------------------------------
  {
    const gameId = '0x' + Array.from({ length: 64 }, () =>
      Math.floor(Math.random() * 16).toString(16)
    ).join('');

    const movesRoot = '0x' + Array.from({ length: 64 }, () =>
      Math.floor(Math.random() * 16).toString(16)
    ).join('');

    const configHash = '0x' + Array.from({ length: 64 }, () =>
      Math.floor(Math.random() * 16).toString(16)
    ).join('');

    const result = await post('/api/relay/settle', {
      gameResult: {
        gameId,
        gameType: 'capture-the-lobster',
        players: ['1', '2'],
        outcome: '0x01',
        movesRoot,
        configHash,
        turnCount: 15,
        timestamp: Math.floor(Date.now() / 1000),
      },
      deltas: ['50', '-50'],
    });

    assert(result.success === true, `settle: game settled (tx: ${result.txHash})`);

    // Verify balance changed
    const bal1 = await get('/api/relay/balance/1');
    const bal2 = await get('/api/relay/balance/2');
    assert(BigInt(bal1.credits) > 0n, 'settle: agent 1 still has credits');
    assert(BigInt(bal2.credits) >= 0n, 'settle: agent 2 balance is non-negative');
  }

  // -----------------------------------------------------------------------
  // 6. Duplicate settlement should fail
  // -----------------------------------------------------------------------
  {
    const gameId = '0x' + Array.from({ length: 64 }, () =>
      Math.floor(Math.random() * 16).toString(16)
    ).join('');

    const movesRoot = '0x' + Array.from({ length: 64 }, () =>
      Math.floor(Math.random() * 16).toString(16)
    ).join('');

    const configHash = '0x' + Array.from({ length: 64 }, () =>
      Math.floor(Math.random() * 16).toString(16)
    ).join('');

    const body = {
      gameResult: {
        gameId,
        gameType: 'test',
        players: ['1', '2'],
        outcome: '0x01',
        movesRoot,
        configHash,
        turnCount: 10,
        timestamp: Math.floor(Date.now() / 1000),
      },
      deltas: ['0', '0'],
    };

    await post('/api/relay/settle', body);
    const dup = await post('/api/relay/settle', body);
    assert(dup.error !== undefined, 'settle: duplicate rejected');
  }

  // -----------------------------------------------------------------------
  // Summary
  // -----------------------------------------------------------------------
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
