import { loadFixture } from '@nomicfoundation/hardhat-toolbox/network-helpers';
import { expect } from 'chai';
import { ethers } from 'hardhat';

describe('CoordinationRegistry', () => {
  async function deployFixture() {
    const [deployer, user1, user2, treasury] = await ethers.getSigners();

    const MockUSDC = await ethers.getContractFactory('MockUSDC');
    const usdc = await MockUSDC.deploy();

    const MockERC8004 = await ethers.getContractFactory('MockERC8004');
    const erc8004 = await MockERC8004.deploy();

    const vault = ethers.Wallet.createRandom().address;

    // Use nonce prediction to resolve circular deps
    const nonce = await ethers.provider.getTransactionCount(deployer.address);
    const registryAddr = ethers.getCreateAddress({ from: deployer.address, nonce });
    const creditsAddr = ethers.getCreateAddress({ from: deployer.address, nonce: nonce + 1 });

    const CoordinationRegistry = await ethers.getContractFactory('CoordinationRegistry');
    const registry = await CoordinationRegistry.deploy(
      await erc8004.getAddress(),
      await usdc.getAddress(),
      creditsAddr,
      treasury.address,
    );

    const CoordinationCredits = await ethers.getContractFactory('CoordinationCredits');
    const credits = await CoordinationCredits.deploy(
      await erc8004.getAddress(),
      await usdc.getAddress(),
      registryAddr,
      deployer.address, // gameAnchor placeholder
      treasury.address,
      vault,
      deployer.address,
    );

    expect(await registry.getAddress()).to.equal(registryAddr);
    expect(await credits.getAddress()).to.equal(creditsAddr);

    // Vault approves credits for burns
    // (vault is a random address, can't sign — not needed for registry tests)

    // Mint USDC to users
    await usdc.mint(user1.address, 100_000_000n);
    await usdc.mint(user2.address, 100_000_000n);

    return { registry, credits, usdc, erc8004, deployer, user1, user2, treasury, vault };
  }

  describe('registerNew', () => {
    it('should register a new agent', async () => {
      const { registry, credits, usdc, user1, treasury } = await loadFixture(deployFixture);

      await usdc.connect(user1).approve(await registry.getAddress(), 5_000_000n);

      await expect(
        registry
          .connect(user1)
          .registerNew(
            user1.address,
            'Alice',
            'https://alice.ai',
            0,
            0,
            ethers.ZeroHash,
            ethers.ZeroHash,
          ),
      ).to.emit(registry, 'Registered');

      // Treasury should have received $1 fee
      expect(await usdc.balanceOf(treasury.address)).to.equal(1_000_000n);

      // Agent should have 400 credits (4 USDC * 100 = 400)
      // agentId is 1 (first registration in mock)
      expect(await credits.balances(1n)).to.equal(400_000_000n);
    });

    it('should reject invalid names', async () => {
      const { registry, usdc, user1 } = await loadFixture(deployFixture);
      await usdc.connect(user1).approve(await registry.getAddress(), 5_000_000n);

      await expect(
        registry
          .connect(user1)
          .registerNew(user1.address, 'ab', 'uri', 0, 0, ethers.ZeroHash, ethers.ZeroHash),
      ).to.be.revertedWithCustomError(registry, 'InvalidName');

      await expect(
        registry
          .connect(user1)
          .registerNew(
            user1.address,
            'a'.repeat(21),
            'uri',
            0,
            0,
            ethers.ZeroHash,
            ethers.ZeroHash,
          ),
      ).to.be.revertedWithCustomError(registry, 'InvalidName');

      await expect(
        registry
          .connect(user1)
          .registerNew(user1.address, 'al!ce', 'uri', 0, 0, ethers.ZeroHash, ethers.ZeroHash),
      ).to.be.revertedWithCustomError(registry, 'InvalidName');
    });

    it('should enforce case-insensitive uniqueness', async () => {
      const { registry, usdc, user1, user2 } = await loadFixture(deployFixture);

      await usdc.connect(user1).approve(await registry.getAddress(), 5_000_000n);
      await registry
        .connect(user1)
        .registerNew(user1.address, 'Alice', 'uri', 0, 0, ethers.ZeroHash, ethers.ZeroHash);

      await usdc.connect(user2).approve(await registry.getAddress(), 5_000_000n);
      await expect(
        registry
          .connect(user2)
          .registerNew(user2.address, 'alice', 'uri2', 0, 0, ethers.ZeroHash, ethers.ZeroHash),
      ).to.be.revertedWithCustomError(registry, 'NameTaken');

      await expect(
        registry
          .connect(user2)
          .registerNew(user2.address, 'ALICE', 'uri3', 0, 0, ethers.ZeroHash, ethers.ZeroHash),
      ).to.be.revertedWithCustomError(registry, 'NameTaken');
    });

    it('should accept valid name characters', async () => {
      const { registry, usdc, user1 } = await loadFixture(deployFixture);
      await usdc.connect(user1).approve(await registry.getAddress(), 5_000_000n);

      await expect(
        registry
          .connect(user1)
          .registerNew(user1.address, 'Agent_01-X', 'uri', 0, 0, ethers.ZeroHash, ethers.ZeroHash),
      ).to.emit(registry, 'Registered');
    });
  });

  describe('registerExisting', () => {
    it('should register an existing agent', async () => {
      const { registry, usdc, erc8004, user1 } = await loadFixture(deployFixture);

      const agentId = await erc8004.connect(user1).mintTo.staticCall(user1.address, 'uri');
      await erc8004.connect(user1).mintTo(user1.address, 'uri');

      await usdc.connect(user1).approve(await registry.getAddress(), 5_000_000n);

      await expect(
        registry
          .connect(user1)
          .registerExisting(user1.address, 'Bob', agentId, 0, 0, ethers.ZeroHash, ethers.ZeroHash),
      ).to.emit(registry, 'Registered');
    });

    it('should reject if caller is not agent owner', async () => {
      const { registry, usdc, erc8004, user1, user2 } = await loadFixture(deployFixture);

      const agentId = await erc8004.connect(user1).mintTo.staticCall(user1.address, 'uri');
      await erc8004.connect(user1).mintTo(user1.address, 'uri');

      await usdc.connect(user2).approve(await registry.getAddress(), 5_000_000n);

      await expect(
        registry
          .connect(user2)
          .registerExisting(user2.address, 'Bob', agentId, 0, 0, ethers.ZeroHash, ethers.ZeroHash),
      ).to.be.revertedWithCustomError(registry, 'NotAgentOwner');
    });

    it('should prevent double registration', async () => {
      const { registry, usdc, erc8004, user1 } = await loadFixture(deployFixture);

      const agentId = await erc8004.connect(user1).mintTo.staticCall(user1.address, 'uri');
      await erc8004.connect(user1).mintTo(user1.address, 'uri');

      await usdc.connect(user1).approve(await registry.getAddress(), 10_000_000n);

      await registry
        .connect(user1)
        .registerExisting(user1.address, 'Bob', agentId, 0, 0, ethers.ZeroHash, ethers.ZeroHash);

      await expect(
        registry
          .connect(user1)
          .registerExisting(user1.address, 'Bob2', agentId, 0, 0, ethers.ZeroHash, ethers.ZeroHash),
      ).to.be.revertedWithCustomError(registry, 'AlreadyRegistered');
    });
  });

  describe('checkName', () => {
    it('should return true for available names', async () => {
      const { registry } = await loadFixture(deployFixture);
      expect(await registry.checkName('NewAgent')).to.be.true;
    });

    it('should return false for taken names', async () => {
      const { registry, usdc, user1 } = await loadFixture(deployFixture);
      await usdc.connect(user1).approve(await registry.getAddress(), 5_000_000n);
      await registry
        .connect(user1)
        .registerNew(user1.address, 'Taken', 'uri', 0, 0, ethers.ZeroHash, ethers.ZeroHash);
      expect(await registry.checkName('taken')).to.be.false;
    });

    it('should return false for invalid names', async () => {
      const { registry } = await loadFixture(deployFixture);
      expect(await registry.checkName('ab')).to.be.false;
      expect(await registry.checkName('no spaces')).to.be.false;
    });
  });
});
