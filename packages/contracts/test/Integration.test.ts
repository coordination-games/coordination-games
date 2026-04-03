import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";

describe("Integration", function () {
  async function deployFullSystemFixture() {
    const [deployer, relayer, user1, user2, treasuryAddr, vaultAddr] =
      await ethers.getSigners();

    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    const usdc = await MockUSDC.deploy();

    const MockERC8004 = await ethers.getContractFactory("MockERC8004");
    const erc8004 = await MockERC8004.deploy();

    // Predict addresses for circular dependency resolution
    const deployerNonce = await ethers.provider.getTransactionCount(deployer.address);
    // nonce+0 = Registry, nonce+1 = Credits, nonce+2 = GameAnchor
    const registryAddr = ethers.getCreateAddress({ from: deployer.address, nonce: deployerNonce });
    const creditsAddr = ethers.getCreateAddress({ from: deployer.address, nonce: deployerNonce + 1 });
    const gameAnchorAddr = ethers.getCreateAddress({ from: deployer.address, nonce: deployerNonce + 2 });

    const CoordinationRegistry = await ethers.getContractFactory("CoordinationRegistry");
    const registry = await CoordinationRegistry.deploy(
      await erc8004.getAddress(),
      await usdc.getAddress(),
      creditsAddr,
      treasuryAddr.address
    );

    const CoordinationCredits = await ethers.getContractFactory("CoordinationCredits");
    const credits = await CoordinationCredits.deploy(
      await erc8004.getAddress(),
      await usdc.getAddress(),
      registryAddr,
      gameAnchorAddr,
      treasuryAddr.address,
      vaultAddr.address,
      deployer.address
    );

    const GameAnchor = await ethers.getContractFactory("GameAnchor");
    const gameAnchor = await GameAnchor.deploy(creditsAddr, relayer.address, deployer.address);

    // Verify addresses
    expect(await registry.getAddress()).to.equal(registryAddr);
    expect(await credits.getAddress()).to.equal(creditsAddr);
    expect(await gameAnchor.getAddress()).to.equal(gameAnchorAddr);

    // Mint USDC to users
    await usdc.mint(user1.address, 100_000_000n);
    await usdc.mint(user2.address, 100_000_000n);

    // Vault needs to approve credits for burns
    await usdc.mint(vaultAddr.address, 100_000_000n);
    await usdc.connect(vaultAddr).approve(creditsAddr, ethers.MaxUint256);

    return {
      registry, credits, gameAnchor, usdc, erc8004,
      deployer, relayer, user1, user2, treasuryAddr, vaultAddr,
    };
  }

  it("full flow: register → mint → play → settle → burn → cashout", async function () {
    const { registry, credits, gameAnchor, usdc, erc8004, relayer, user1, user2, treasuryAddr } =
      await loadFixture(deployFullSystemFixture);

    // === Step 1: Register two agents using registerExisting ===
    // Mint ERC-8004 agents directly to users so they own them
    const agentId1 = await erc8004.mintTo.staticCall(user1.address, "https://alpha.ai");
    await erc8004.mintTo(user1.address, "https://alpha.ai");

    const agentId2 = await erc8004.mintTo.staticCall(user2.address, "https://beta.ai");
    await erc8004.mintTo(user2.address, "https://beta.ai");

    // User1 registers
    await usdc.connect(user1).approve(await registry.getAddress(), 5_000_000n);
    await registry.connect(user1).registerExisting(
      "AlphaBot", agentId1, 0, 0, ethers.ZeroHash, ethers.ZeroHash
    );

    // User2 registers
    await usdc.connect(user2).approve(await registry.getAddress(), 5_000_000n);
    await registry.connect(user2).registerExisting(
      "BetaBot", agentId2, 0, 0, ethers.ZeroHash, ethers.ZeroHash
    );

    // Both agents get 400_000_000 credits (4 USDC * 100)
    expect(await credits.balances(agentId1)).to.equal(400_000_000n);
    expect(await credits.balances(agentId2)).to.equal(400_000_000n);

    // Treasury got $2 in registration fees
    expect(await usdc.balanceOf(treasuryAddr.address)).to.equal(2_000_000n);

    // === Step 2: Mint additional credits (user1 owns agentId1) ===
    await usdc.connect(user1).approve(await credits.getAddress(), 10_000_000n);
    await credits.connect(user1).mint(agentId1, 10_000_000n);

    // 10 USDC with 10% tax: 1 USDC tax, 9 USDC deposited, 900_000_000 credits
    expect(await credits.balances(agentId1)).to.equal(400_000_000n + 900_000_000n);

    // === Step 3: Play and settle a game ===
    const gameResult = {
      gameId: ethers.id("integration-game-1"),
      gameType: "capture-the-lobster",
      players: [agentId1, agentId2],
      outcome: "0x01",
      movesRoot: ethers.id("full-move-log"),
      configHash: ethers.id("config-v1"),
      turnCount: 25,
      timestamp: Math.floor(Date.now() / 1000),
    };

    const deltas = [50_000n, -50_000n];

    const bal1Before = await credits.balances(agentId1);
    const bal2Before = await credits.balances(agentId2);

    await gameAnchor.connect(relayer).settleGame(gameResult, deltas);

    expect(await credits.balances(agentId1)).to.equal(bal1Before + 50_000n);
    expect(await credits.balances(agentId2)).to.equal(bal2Before - 50_000n);

    // Verify game stored
    const stored = await gameAnchor.results(gameResult.gameId);
    expect(stored.turnCount).to.equal(25);
    expect(stored.movesRoot).to.equal(ethers.id("full-move-log"));

    // === Step 4: Burn and cashout ===
    const burnAmount = 200_000_000n; // 200M credits = 2M USDC = $2
    await credits.connect(user1).requestBurn(agentId1, burnAmount);

    // Wait for burn delay
    await time.increase(3601);

    const usdcBefore = await usdc.balanceOf(user1.address);
    await credits.connect(user1).executeBurn(agentId1);

    // 200_000_000 credits / 100 = 2_000_000 USDC ($2)
    expect(await usdc.balanceOf(user1.address)).to.equal(usdcBefore + 2_000_000n);

    // Credits decreased
    expect(await credits.balances(agentId1)).to.equal(bal1Before + 50_000n - burnAmount);
  });

  it("name collision across registrations", async function () {
    const { registry, usdc, erc8004, user1, user2 } = await loadFixture(deployFullSystemFixture);

    const agentId1 = await erc8004.mintTo.staticCall(user1.address, "uri1");
    await erc8004.mintTo(user1.address, "uri1");

    await usdc.connect(user1).approve(await registry.getAddress(), 5_000_000n);
    await registry.connect(user1).registerExisting(
      "TopAgent", agentId1, 0, 0, ethers.ZeroHash, ethers.ZeroHash
    );

    expect(await registry.checkName("topagent")).to.be.false;
    expect(await registry.checkName("TOPAGENT")).to.be.false;
    expect(await registry.checkName("TopAgent")).to.be.false;
    expect(await registry.checkName("DiffName")).to.be.true;
  });

  it("non-transferable credits cannot be moved", async function () {
    const { credits, user1, user2 } = await loadFixture(deployFullSystemFixture);

    await expect(
      credits.connect(user1).transfer(user2.address, 1n)
    ).to.be.revertedWithCustomError(credits, "NonTransferable");

    await expect(
      credits.connect(user1).transferFrom(user1.address, user2.address, 1n)
    ).to.be.revertedWithCustomError(credits, "NonTransferable");
  });
});
