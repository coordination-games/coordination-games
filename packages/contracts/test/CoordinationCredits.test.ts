import { loadFixture, time } from '@nomicfoundation/hardhat-toolbox/network-helpers';
import { expect } from 'chai';
import { ethers } from 'hardhat';

describe('CoordinationCredits', () => {
  async function deployFixture() {
    const [admin, registryRole, gameAnchorRole, user1, user2, treasuryAddr, vaultAddr] =
      await ethers.getSigners();

    const MockUSDC = await ethers.getContractFactory('MockUSDC');
    const usdc = await MockUSDC.deploy();

    const MockERC8004 = await ethers.getContractFactory('MockERC8004');
    const erc8004 = await MockERC8004.deploy();

    const CoordinationCredits = await ethers.getContractFactory('CoordinationCredits');
    const credits = await CoordinationCredits.deploy(
      await erc8004.getAddress(),
      await usdc.getAddress(),
      registryRole.address,
      gameAnchorRole.address,
      treasuryAddr.address,
      vaultAddr.address,
      admin.address,
    );

    // Mint USDC to users and registry
    await usdc.mint(user1.address, 100_000_000n);
    await usdc.mint(user2.address, 100_000_000n);
    await usdc.mint(registryRole.address, 100_000_000n);

    // Mint agent IDs to users
    const agentId1 = await erc8004.mintTo.staticCall(user1.address, 'uri1');
    await erc8004.mintTo(user1.address, 'uri1');
    const agentId2 = await erc8004.mintTo.staticCall(user2.address, 'uri2');
    await erc8004.mintTo(user2.address, 'uri2');

    // Vault approves credits contract to pull USDC for burns
    await usdc.mint(vaultAddr.address, 100_000_000n);
    await usdc.connect(vaultAddr).approve(await credits.getAddress(), ethers.MaxUint256);

    return {
      credits,
      usdc,
      erc8004,
      admin,
      registryRole,
      gameAnchorRole,
      user1,
      user2,
      treasuryAddr,
      vaultAddr,
      agentId1,
      agentId2,
    };
  }

  describe('mint (10% tax)', () => {
    it('should mint credits with 10% tax', async () => {
      const { credits, usdc, user1, agentId1, treasuryAddr, vaultAddr } =
        await loadFixture(deployFixture);

      await usdc.connect(user1).approve(await credits.getAddress(), 10_000_000n);
      await credits.connect(user1).mint(agentId1, 10_000_000n); // 10 USDC

      // 10% tax = 1 USDC to treasury, 9 USDC to vault
      expect(await usdc.balanceOf(treasuryAddr.address)).to.equal(1_000_000n);
      // vault got 100M mint + 9M deposit
      expect(await usdc.balanceOf(vaultAddr.address)).to.equal(109_000_000n);

      // Credits: 9 USDC (9_000_000) * 100 = 900_000_000 credits
      expect(await credits.balances(agentId1)).to.equal(900_000_000n);
    });

    it('should reject if not agent owner', async () => {
      const { credits, usdc, user2, agentId1 } = await loadFixture(deployFixture);
      await usdc.connect(user2).approve(await credits.getAddress(), 10_000_000n);

      await expect(
        credits.connect(user2).mint(agentId1, 10_000_000n),
      ).to.be.revertedWithCustomError(credits, 'NotAgentOwner');
    });
  });

  describe('mintFor (0% tax)', () => {
    it('should mint without tax from registry', async () => {
      const { credits, usdc, registryRole, agentId1, vaultAddr } = await loadFixture(deployFixture);

      await usdc.connect(registryRole).approve(await credits.getAddress(), 4_000_000n);
      await credits.connect(registryRole).mintFor(agentId1, 4_000_000n);

      // 400 credits, 0 tax
      expect(await credits.balances(agentId1)).to.equal(400_000_000n);
      expect(await usdc.balanceOf(vaultAddr.address)).to.equal(104_000_000n);
    });

    it('should reject if not registry', async () => {
      const { credits, user1, agentId1 } = await loadFixture(deployFixture);

      await expect(
        credits.connect(user1).mintFor(agentId1, 1_000_000n),
      ).to.be.revertedWithCustomError(credits, 'NotRegistry');
    });
  });

  describe('non-transferability', () => {
    it('should revert transfer', async () => {
      const { credits, user1, user2 } = await loadFixture(deployFixture);
      await expect(
        credits.connect(user1).transfer(user2.address, 100n),
      ).to.be.revertedWithCustomError(credits, 'NonTransferable');
    });

    it('should revert transferFrom', async () => {
      const { credits, user1, user2 } = await loadFixture(deployFixture);
      await expect(
        credits.connect(user1).transferFrom(user1.address, user2.address, 100n),
      ).to.be.revertedWithCustomError(credits, 'NonTransferable');
    });
  });

  describe('settleDeltas', () => {
    it('should apply zero-sum deltas', async () => {
      const { credits, usdc, registryRole, gameAnchorRole, agentId1, agentId2 } =
        await loadFixture(deployFixture);

      // Give both agents some credits
      await usdc.connect(registryRole).approve(await credits.getAddress(), 10_000_000n);
      await credits.connect(registryRole).mintFor(agentId1, 5_000_000n);
      await credits.connect(registryRole).mintFor(agentId2, 5_000_000n);

      const balBefore1 = await credits.balances(agentId1);
      const balBefore2 = await credits.balances(agentId2);

      // Agent1 wins 100 credits from Agent2
      await credits.connect(gameAnchorRole).settleDeltas([agentId1, agentId2], [100n, -100n]);

      expect(await credits.balances(agentId1)).to.equal(balBefore1 + 100n);
      expect(await credits.balances(agentId2)).to.equal(balBefore2 - 100n);
    });

    it('should reject non-zero-sum deltas', async () => {
      const { credits, gameAnchorRole, agentId1, agentId2 } = await loadFixture(deployFixture);

      await expect(
        credits.connect(gameAnchorRole).settleDeltas([agentId1, agentId2], [100n, -50n]),
      ).to.be.revertedWithCustomError(credits, 'ZeroSumViolation');
    });

    it('should reject if not gameAnchor', async () => {
      const { credits, user1, agentId1, agentId2 } = await loadFixture(deployFixture);

      await expect(
        credits.connect(user1).settleDeltas([agentId1, agentId2], [100n, -100n]),
      ).to.be.revertedWithCustomError(credits, 'NotGameAnchor');
    });

    it('should reject length mismatch', async () => {
      const { credits, gameAnchorRole, agentId1 } = await loadFixture(deployFixture);

      await expect(
        credits.connect(gameAnchorRole).settleDeltas([agentId1], [100n, -100n]),
      ).to.be.revertedWithCustomError(credits, 'LengthMismatch');
    });

    it('should revert when debit exceeds balance (no silent mint)', async () => {
      const { credits, gameAnchorRole, agentId1, agentId2 } = await loadFixture(deployFixture);

      // Agent1 has 0 credits, a debit of -100 cannot be applied. The prior
      // behavior was a silent clamp to 0 which broke zero-sum on-chain and
      // effectively minted credits to the winner. Must revert instead.
      await expect(
        credits.connect(gameAnchorRole).settleDeltas([agentId1, agentId2], [-100n, 100n]),
      ).to.be.revertedWithCustomError(credits, 'InsufficientBalance');

      expect(await credits.balances(agentId1)).to.equal(0n);
      expect(await credits.balances(agentId2)).to.equal(0n);
    });
  });

  describe('burn lifecycle', () => {
    it('should request, wait, and execute burn', async () => {
      const { credits, usdc, registryRole, user1, agentId1 } = await loadFixture(deployFixture);

      // Mint some credits
      await usdc.connect(registryRole).approve(await credits.getAddress(), 10_000_000n);
      await credits.connect(registryRole).mintFor(agentId1, 10_000_000n);
      // 10 USDC * 100 = 1000 credits (with 0% tax via mintFor)
      const expectedCredits = 1_000_000_000n;
      expect(await credits.balances(agentId1)).to.equal(expectedCredits);

      const burnAmount = 500_000_000n; // 500 credits = 5 USDC
      await credits.connect(user1).requestBurn(agentId1, burnAmount);

      // Can't execute yet
      await expect(credits.connect(user1).executeBurn(agentId1)).to.be.revertedWithCustomError(
        credits,
        'BurnNotReady',
      );

      // Fast forward past burn delay
      await time.increase(3601);

      const balBefore = await usdc.balanceOf(user1.address);
      await credits.connect(user1).executeBurn(agentId1);

      // Credits burned
      expect(await credits.balances(agentId1)).to.equal(expectedCredits - burnAmount);

      // USDC received: 500_000_000 / 100 = 5_000_000 (5 USDC)
      expect(await usdc.balanceOf(user1.address)).to.equal(balBefore + 5_000_000n);
    });

    it('should cancel burn', async () => {
      const { credits, usdc, registryRole, user1, agentId1 } = await loadFixture(deployFixture);

      await usdc.connect(registryRole).approve(await credits.getAddress(), 10_000_000n);
      await credits.connect(registryRole).mintFor(agentId1, 10_000_000n);

      await credits.connect(user1).requestBurn(agentId1, 500n);
      await credits.connect(user1).cancelBurn(agentId1);

      // No pending burn
      await expect(credits.connect(user1).executeBurn(agentId1)).to.be.revertedWithCustomError(
        credits,
        'NoPendingBurn',
      );
    });

    it('should reject burn request with insufficient balance', async () => {
      const { credits, user1, agentId1 } = await loadFixture(deployFixture);

      await expect(
        credits.connect(user1).requestBurn(agentId1, 100n),
      ).to.be.revertedWithCustomError(credits, 'InsufficientBalance');
    });

    it('should pay USDC to the requester, not the executor', async () => {
      const { credits, usdc, registryRole, user1, user2, agentId1 } =
        await loadFixture(deployFixture);

      await usdc.connect(registryRole).approve(await credits.getAddress(), 10_000_000n);
      await credits.connect(registryRole).mintFor(agentId1, 10_000_000n);

      await credits.connect(user1).requestBurn(agentId1, 500_000_000n);
      await time.increase(3601);

      const user1Before = await usdc.balanceOf(user1.address);
      const user2Before = await usdc.balanceOf(user2.address);

      // user2 (any address) executes the burn — permissionless execution.
      await credits.connect(user2).executeBurn(agentId1);

      // USDC goes to user1 (the requester), not user2 (the executor).
      expect(await usdc.balanceOf(user1.address)).to.equal(user1Before + 5_000_000n);
      expect(await usdc.balanceOf(user2.address)).to.equal(user2Before);
    });

    it('should pay the original requester even after agent NFT transfer', async () => {
      const { credits, usdc, erc8004, registryRole, user1, user2, agentId1 } =
        await loadFixture(deployFixture);

      await usdc.connect(registryRole).approve(await credits.getAddress(), 10_000_000n);
      await credits.connect(registryRole).mintFor(agentId1, 10_000_000n);

      // user1 (owner) requests burn.
      await credits.connect(user1).requestBurn(agentId1, 500_000_000n);

      // Agent NFT is transferred to user2 mid-cooldown.
      await erc8004.connect(user1).transferFrom(user1.address, user2.address, agentId1);

      await time.increase(3601);

      const user1Before = await usdc.balanceOf(user1.address);
      const user2Before = await usdc.balanceOf(user2.address);

      // Anyone executes — payout still goes to user1, the requester who
      // staked the credits, not the current NFT owner.
      await credits.connect(user2).executeBurn(agentId1);

      expect(await usdc.balanceOf(user1.address)).to.equal(user1Before + 5_000_000n);
      expect(await usdc.balanceOf(user2.address)).to.equal(user2Before);
    });
  });

  describe('admin', () => {
    it('should allow admin to set burn delay', async () => {
      const { credits, admin } = await loadFixture(deployFixture);

      await credits.connect(admin).setBurnDelay(7200);
      expect(await credits.burnDelay()).to.equal(7200);
    });

    it('should reject burn delay exceeding max', async () => {
      const { credits, admin } = await loadFixture(deployFixture);

      await expect(credits.connect(admin).setBurnDelay(86401)).to.be.revertedWithCustomError(
        credits,
        'BurnDelayTooLong',
      );
    });

    it('should reject non-admin setting burn delay', async () => {
      const { credits, user1 } = await loadFixture(deployFixture);

      await expect(credits.connect(user1).setBurnDelay(100)).to.be.revertedWithCustomError(
        credits,
        'NotAdmin',
      );
    });
  });
});
