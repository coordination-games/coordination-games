import { ethers } from "hardhat";

async function main() {
  const [deployer, relayer, user1, user2, treasury, vault] = await ethers.getSigners();
  let passed = 0;
  let failed = 0;

  function ok(label: string) {
    console.log(`  [PASS] ${label}`);
    passed++;
  }
  function fail(label: string, err: any) {
    console.log(`  [FAIL] ${label}: ${err?.message ?? err}`);
    failed++;
  }
  function assert(cond: boolean, label: string, detail?: string) {
    if (cond) { ok(label); } else { fail(label, detail ?? "assertion failed"); }
  }

  console.log("\n=== Deploying contracts ===\n");
  console.log("Deployer:", deployer.address);
  console.log("Relayer:", relayer.address);
  console.log("User1:", user1.address);
  console.log("User2:", user2.address);
  console.log("Treasury:", treasury.address);
  console.log("Vault:", vault.address);

  // --- Deploy MockUSDC ---
  const MockUSDC = await ethers.getContractFactory("MockUSDC");
  const usdc = await MockUSDC.deploy();
  await usdc.waitForDeployment();
  console.log("\nMockUSDC:", await usdc.getAddress());

  // --- Deploy MockERC8004 ---
  const MockERC8004 = await ethers.getContractFactory("MockERC8004");
  const erc8004 = await MockERC8004.deploy();
  await erc8004.waitForDeployment();
  console.log("MockERC8004:", await erc8004.getAddress());

  // --- Predict addresses for circular deps ---
  const deployerNonce = await ethers.provider.getTransactionCount(deployer.address);
  const registryAddr = ethers.getCreateAddress({ from: deployer.address, nonce: deployerNonce });
  const creditsAddr = ethers.getCreateAddress({ from: deployer.address, nonce: deployerNonce + 1 });
  const gameAnchorAddr = ethers.getCreateAddress({ from: deployer.address, nonce: deployerNonce + 2 });

  // --- Deploy CoordinationRegistry ---
  const CoordinationRegistry = await ethers.getContractFactory("CoordinationRegistry");
  const registry = await CoordinationRegistry.deploy(
    await erc8004.getAddress(),
    await usdc.getAddress(),
    creditsAddr,
    treasury.address
  );
  await registry.waitForDeployment();
  console.log("CoordinationRegistry:", await registry.getAddress());

  // --- Deploy CoordinationCredits ---
  const CoordinationCredits = await ethers.getContractFactory("CoordinationCredits");
  const credits = await CoordinationCredits.deploy(
    await erc8004.getAddress(),
    await usdc.getAddress(),
    registryAddr,
    gameAnchorAddr,
    treasury.address,
    vault.address,
    deployer.address // admin
  );
  await credits.waitForDeployment();
  console.log("CoordinationCredits:", await credits.getAddress());

  // --- Deploy GameAnchor ---
  const GameAnchor = await ethers.getContractFactory("GameAnchor");
  const gameAnchor = await GameAnchor.deploy(creditsAddr, relayer.address, deployer.address);
  await gameAnchor.waitForDeployment();
  console.log("GameAnchor:", await gameAnchor.getAddress());

  // Verify predicted addresses
  assert(await registry.getAddress() === registryAddr, "Registry address prediction");
  assert(await credits.getAddress() === creditsAddr, "Credits address prediction");
  assert(await gameAnchor.getAddress() === gameAnchorAddr, "GameAnchor address prediction");

  // --- Mint USDC to test accounts ---
  await usdc.mint(user1.address, 100_000_000n); // $100
  await usdc.mint(user2.address, 100_000_000n); // $100
  ok("Minted 100 USDC to user1 and user2");

  // Vault needs USDC for burn payouts + must approve credits contract
  await usdc.mint(vault.address, 100_000_000n);
  await usdc.connect(vault).approve(creditsAddr, ethers.MaxUint256);
  ok("Vault funded and approved credits contract");

  console.log("\n=== Running E2E flow ===\n");

  // ============================================================
  // Step (a): Register agent 1 using registerExisting
  // ============================================================
  try {
    // Mint ERC-8004 NFT to user1
    const agentId1 = await erc8004.mintTo.staticCall(user1.address, "https://agent1.ai");
    await erc8004.mintTo(user1.address, "https://agent1.ai");

    // Approve USDC for registry ($1 reg fee + $4 initial credits = $5)
    await usdc.connect(user1).approve(await registry.getAddress(), 5_000_000n);
    ok("(a) Approved USDC for registry");

    // Register
    await registry.connect(user1).registerExisting(
      "testplayer", agentId1, 0, 0, ethers.ZeroHash, ethers.ZeroHash
    );
    ok("(b) Registered agent 'testplayer'");

    // (c) Verify NFT ownership
    const nftOwner = await erc8004.ownerOf(agentId1);
    assert(nftOwner === user1.address, "(c) ERC-8004 NFT owned by user1");

    // (d) Verify 400 credits minted (4 USDC * 100 = 400 credits, stored as 400_000_000)
    const creditBal1 = await credits.balances(agentId1);
    assert(creditBal1 === 400_000_000n, `(d) 400M credits minted (got ${creditBal1})`);

    // (e) Top up with more USDC (10% fee)
    const topUpAmount = 10_000_000n; // $10
    await usdc.connect(user1).approve(await credits.getAddress(), topUpAmount);
    await credits.connect(user1).mint(agentId1, topUpAmount);
    ok("(e) Topped up with $10 USDC");

    // (f) Verify credit balance increased by 90% of deposit
    // 10 USDC - 10% fee = 9 USDC net. 9 USDC * 100 = 900 credits = 900_000_000
    const creditBal1After = await credits.balances(agentId1);
    const expectedAfterTopUp = 400_000_000n + 900_000_000n;
    assert(
      creditBal1After === expectedAfterTopUp,
      `(f) Credits after top-up: ${creditBal1After} === ${expectedAfterTopUp}`
    );

    // (g) Request a burn
    const burnAmount = 200_000_000n; // 200M credits = 2 USDC
    await credits.connect(user1).requestBurn(agentId1, burnAmount);
    ok("(g) Burn requested");

    // (h) Advance time past burn delay (1 hour)
    await ethers.provider.send("evm_increaseTime", [3601]);
    await ethers.provider.send("evm_mine", []);
    ok("(h) Time advanced past burn delay");

    // (i) Execute burn
    const usdcBefore = await usdc.balanceOf(user1.address);
    await credits.connect(user1).executeBurn(agentId1);
    ok("(i) Burn executed");

    // (j) Verify USDC returned from vault
    const usdcAfter = await usdc.balanceOf(user1.address);
    const expectedReturn = 2_000_000n; // 200M credits / 100 = 2M USDC
    assert(
      usdcAfter === usdcBefore + expectedReturn,
      `(j) USDC returned: +${usdcAfter - usdcBefore} (expected +${expectedReturn})`
    );

    // Credits decreased
    const creditBal1Final = await credits.balances(agentId1);
    assert(
      creditBal1Final === expectedAfterTopUp - burnAmount,
      `(j) Credits after burn: ${creditBal1Final} === ${expectedAfterTopUp - burnAmount}`
    );

    // ============================================================
    // Step (k): Register a second player
    // ============================================================
    const agentId2 = await erc8004.mintTo.staticCall(user2.address, "https://agent2.ai");
    await erc8004.mintTo(user2.address, "https://agent2.ai");
    await usdc.connect(user2).approve(await registry.getAddress(), 5_000_000n);
    await registry.connect(user2).registerExisting(
      "opponent", agentId2, 0, 0, ethers.ZeroHash, ethers.ZeroHash
    );
    ok("(k) Registered second player 'opponent'");

    const creditBal2 = await credits.balances(agentId2);
    assert(creditBal2 === 400_000_000n, `(k) Second player has 400M credits (got ${creditBal2})`);

    // ============================================================
    // Step (l): Simulate a game: settle with deltas [-10, +10]
    // ============================================================
    const bal1Pre = await credits.balances(agentId1);
    const bal2Pre = await credits.balances(agentId2);

    const gameResult = {
      gameId: ethers.id("e2e-game-1"),
      gameType: "capture-the-lobster",
      players: [agentId1, agentId2],
      outcome: "0x01", // team A wins
      movesRoot: ethers.id("moves-hash"),
      configHash: ethers.id("config"),
      turnCount: 20,
      timestamp: Math.floor(Date.now() / 1000),
    };
    const deltas = [-10n, 10n];

    await gameAnchor.connect(relayer).settleGame(gameResult, deltas);
    ok("(l) Game settled with deltas [-10, +10]");

    // (m) Verify winner gained 10, loser lost 10
    const bal1Post = await credits.balances(agentId1);
    const bal2Post = await credits.balances(agentId2);
    assert(bal1Post === bal1Pre - 10n, `(m) Player 1 lost 10 credits: ${bal1Pre} -> ${bal1Post}`);
    assert(bal2Post === bal2Pre + 10n, `(m) Player 2 gained 10 credits: ${bal2Pre} -> ${bal2Post}`);

    // Verify game is stored
    const stored = await gameAnchor.results(gameResult.gameId);
    assert(stored.turnCount === 20n, "(m) Game result stored with correct turn count");
    assert(stored.movesRoot === ethers.id("moves-hash"), "(m) Game result stored with correct movesRoot");

  } catch (err: any) {
    fail("Unexpected error during E2E flow", err);
    console.error(err);
  }

  // ============================================================
  // Summary
  // ============================================================
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
