import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";

describe("GameAnchor", function () {
  async function deployFixture() {
    const [deployer, relayer, registryRole, user1, user2, treasuryAddr, vaultAddr] =
      await ethers.getSigners();

    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    const usdc = await MockUSDC.deploy();

    const MockERC8004 = await ethers.getContractFactory("MockERC8004");
    const erc8004 = await MockERC8004.deploy();

    // Predict addresses: nonce+0 = credits, nonce+1 = gameAnchor
    const nonce = await ethers.provider.getTransactionCount(deployer.address);
    const creditsAddr = ethers.getCreateAddress({ from: deployer.address, nonce });
    const gameAnchorAddr = ethers.getCreateAddress({ from: deployer.address, nonce: nonce + 1 });

    const CoordinationCredits = await ethers.getContractFactory("CoordinationCredits");
    const credits = await CoordinationCredits.deploy(
      await erc8004.getAddress(),
      await usdc.getAddress(),
      registryRole.address,
      gameAnchorAddr,
      treasuryAddr.address,
      vaultAddr.address,
      deployer.address
    );

    const GameAnchor = await ethers.getContractFactory("GameAnchor");
    const gameAnchor = await GameAnchor.deploy(creditsAddr, relayer.address, deployer.address);

    expect(await credits.getAddress()).to.equal(creditsAddr);
    expect(await gameAnchor.getAddress()).to.equal(gameAnchorAddr);

    // Mint agents to users
    const agentId1 = await erc8004.mintTo.staticCall(user1.address, "uri1");
    await erc8004.mintTo(user1.address, "uri1");
    const agentId2 = await erc8004.mintTo.staticCall(user2.address, "uri2");
    await erc8004.mintTo(user2.address, "uri2");

    // Give agents credits via registry role
    await usdc.mint(registryRole.address, 100_000_000n);
    await usdc.connect(registryRole).approve(creditsAddr, 100_000_000n);
    await credits.connect(registryRole).mintFor(agentId1, 10_000_000n);
    await credits.connect(registryRole).mintFor(agentId2, 10_000_000n);

    return {
      gameAnchor, credits, usdc, erc8004,
      deployer, relayer, registryRole, user1, user2,
      treasuryAddr, vaultAddr, agentId1, agentId2,
    };
  }

  function makeGameResult(gameId: string, players: bigint[], timestamp?: number) {
    return {
      gameId: ethers.id(gameId),
      gameType: "capture-the-lobster",
      players,
      outcome: "0x01",
      movesRoot: ethers.id("moves"),
      configHash: ethers.id("config"),
      turnCount: 15,
      timestamp: timestamp || Math.floor(Date.now() / 1000),
    };
  }

  describe("settleGame", function () {
    it("should settle a valid game", async function () {
      const { gameAnchor, credits, relayer, agentId1, agentId2 } =
        await loadFixture(deployFixture);

      const result = makeGameResult("game-1", [agentId1, agentId2]);
      const deltas = [200n, -200n];

      const bal1Before = await credits.balances(agentId1);
      const bal2Before = await credits.balances(agentId2);

      await expect(
        gameAnchor.connect(relayer).settleGame(result, deltas)
      ).to.emit(gameAnchor, "GameSettled");

      expect(await credits.balances(agentId1)).to.equal(bal1Before + 200n);
      expect(await credits.balances(agentId2)).to.equal(bal2Before - 200n);
    });

    it("should reject duplicate settlement", async function () {
      const { gameAnchor, relayer, agentId1, agentId2 } = await loadFixture(deployFixture);

      const result = makeGameResult("game-2", [agentId1, agentId2]);
      await gameAnchor.connect(relayer).settleGame(result, [100n, -100n]);

      await expect(
        gameAnchor.connect(relayer).settleGame(result, [50n, -50n])
      ).to.be.revertedWithCustomError(gameAnchor, "AlreadySettled");
    });

    it("should reject non-relayer", async function () {
      const { gameAnchor, user1, agentId1, agentId2 } = await loadFixture(deployFixture);

      const result = makeGameResult("game-3", [agentId1, agentId2]);
      await expect(
        gameAnchor.connect(user1).settleGame(result, [0n, 0n])
      ).to.be.revertedWithCustomError(gameAnchor, "NotRelayer");
    });

    it("should reject missing moves root", async function () {
      const { gameAnchor, relayer, agentId1, agentId2 } = await loadFixture(deployFixture);

      const result = {
        gameId: ethers.id("game-4"),
        gameType: "test",
        players: [agentId1, agentId2],
        outcome: "0x01",
        movesRoot: ethers.ZeroHash,
        configHash: ethers.id("config"),
        turnCount: 10,
        timestamp: Math.floor(Date.now() / 1000),
      };

      await expect(
        gameAnchor.connect(relayer).settleGame(result, [0n, 0n])
      ).to.be.revertedWithCustomError(gameAnchor, "MissingMovesRoot");
    });

    it("should reject non-zero-sum deltas", async function () {
      const { gameAnchor, relayer, agentId1, agentId2 } = await loadFixture(deployFixture);

      const result = makeGameResult("game-5", [agentId1, agentId2]);
      await expect(
        gameAnchor.connect(relayer).settleGame(result, [100n, 50n])
      ).to.be.revertedWithCustomError(gameAnchor, "ZeroSumViolation");
    });

    it("should reject length mismatch", async function () {
      const { gameAnchor, relayer, agentId1, agentId2 } = await loadFixture(deployFixture);

      const result = makeGameResult("game-6", [agentId1, agentId2]);
      await expect(
        gameAnchor.connect(relayer).settleGame(result, [100n])
      ).to.be.revertedWithCustomError(gameAnchor, "LengthMismatch");
    });
  });

  describe("emergencyReclaim", function () {
    it("should reject reclaim too early", async function () {
      const { gameAnchor, relayer, agentId1, agentId2 } = await loadFixture(deployFixture);

      const result = makeGameResult("game-reclaim", [agentId1, agentId2]);
      await gameAnchor.connect(relayer).settleGame(result, [0n, 0n]);

      await expect(
        gameAnchor.emergencyReclaim(result.gameId)
      ).to.be.revertedWithCustomError(gameAnchor, "TooEarlyForReclaim");
    });

    it("should allow reclaim after 1 hour", async function () {
      const { gameAnchor, relayer, agentId1, agentId2 } = await loadFixture(deployFixture);

      const result = makeGameResult("game-reclaim2", [agentId1, agentId2]);
      await gameAnchor.connect(relayer).settleGame(result, [0n, 0n]);

      await time.increase(3601);

      await expect(
        gameAnchor.emergencyReclaim(result.gameId)
      ).to.emit(gameAnchor, "EmergencyReclaimed");
    });

    it("should reject reclaim for non-existent game", async function () {
      const { gameAnchor } = await loadFixture(deployFixture);

      await expect(
        gameAnchor.emergencyReclaim(ethers.id("nonexistent"))
      ).to.be.revertedWithCustomError(gameAnchor, "GameNotSettled");
    });

    it("should respect custom reclaim delay", async function () {
      const { gameAnchor, deployer, relayer, agentId1, agentId2 } =
        await loadFixture(deployFixture);

      // Set reclaim delay to 2 hours
      await gameAnchor.connect(deployer).setReclaimDelay(7200);
      expect(await gameAnchor.reclaimDelay()).to.equal(7200);

      const result = makeGameResult("game-custom-delay", [agentId1, agentId2]);
      await gameAnchor.connect(relayer).settleGame(result, [0n, 0n]);

      // Should fail after 1 hour (old default)
      await time.increase(3601);
      await expect(
        gameAnchor.emergencyReclaim(result.gameId)
      ).to.be.revertedWithCustomError(gameAnchor, "TooEarlyForReclaim");

      // Should succeed after 2 hours
      await time.increase(3600);
      await expect(
        gameAnchor.emergencyReclaim(result.gameId)
      ).to.emit(gameAnchor, "EmergencyReclaimed");
    });
  });

  describe("setReclaimDelay", function () {
    it("should allow admin to set delay", async function () {
      const { gameAnchor, deployer } = await loadFixture(deployFixture);

      await expect(
        gameAnchor.connect(deployer).setReclaimDelay(7200)
      ).to.emit(gameAnchor, "ReclaimDelayUpdated").withArgs(7200);

      expect(await gameAnchor.reclaimDelay()).to.equal(7200);
    });

    it("should reject non-admin", async function () {
      const { gameAnchor, user1 } = await loadFixture(deployFixture);

      await expect(
        gameAnchor.connect(user1).setReclaimDelay(7200)
      ).to.be.revertedWithCustomError(gameAnchor, "NotAdmin");
    });

    it("should reject delay exceeding max (1 week)", async function () {
      const { gameAnchor, deployer } = await loadFixture(deployFixture);

      await expect(
        gameAnchor.connect(deployer).setReclaimDelay(604801)
      ).to.be.revertedWithCustomError(gameAnchor, "ReclaimDelayTooLong");
    });

    it("should allow setting delay to max (1 week)", async function () {
      const { gameAnchor, deployer } = await loadFixture(deployFixture);

      await gameAnchor.connect(deployer).setReclaimDelay(604800);
      expect(await gameAnchor.reclaimDelay()).to.equal(604800);
    });

    it("should allow setting delay to zero", async function () {
      const { gameAnchor, deployer } = await loadFixture(deployFixture);

      await gameAnchor.connect(deployer).setReclaimDelay(0);
      expect(await gameAnchor.reclaimDelay()).to.equal(0);
    });
  });
});
