import { loadFixture } from '@nomicfoundation/hardhat-toolbox/network-helpers';
import { expect } from 'chai';
import { ethers } from 'hardhat';

describe('GameAnchor treasury settlement', () => {
  async function deployTreasuryFixture() {
    const [deployer, relayer, user1, user2, treasuryAddress, vaultAddress, treasuryAgent] =
      await ethers.getSigners();
    const MockUSDC = await ethers.getContractFactory('MockUSDC');
    const usdc = await MockUSDC.deploy();
    const MockERC8004 = await ethers.getContractFactory('MockERC8004');
    const erc8004 = await MockERC8004.deploy();
    const deployerNonce = await ethers.provider.getTransactionCount(deployer.address);
    const registryAddress = ethers.getCreateAddress({
      from: deployer.address,
      nonce: deployerNonce,
    });
    const creditsAddress = ethers.getCreateAddress({
      from: deployer.address,
      nonce: deployerNonce + 1,
    });
    const gameAnchorAddress = ethers.getCreateAddress({
      from: deployer.address,
      nonce: deployerNonce + 2,
    });
    const CoordinationRegistry = await ethers.getContractFactory('CoordinationRegistry');
    const registry = await CoordinationRegistry.deploy(
      await erc8004.getAddress(),
      await usdc.getAddress(),
      creditsAddress,
      treasuryAddress.address,
    );
    const CoordinationCredits = await ethers.getContractFactory('CoordinationCredits');
    const credits = await CoordinationCredits.deploy(
      await erc8004.getAddress(),
      await usdc.getAddress(),
      registryAddress,
      gameAnchorAddress,
      treasuryAddress.address,
      vaultAddress.address,
      deployer.address,
    );
    const GameAnchor = await ethers.getContractFactory('GameAnchor');
    const gameAnchor = await GameAnchor.deploy(creditsAddress, relayer.address, deployer.address);
    return { erc8004, usdc, registry, credits, gameAnchor, relayer, user1, user2, treasuryAgent };
  }

  it('settles a third registered treasury agent at zero delta while retaining zero-sum and length checks', async () => {
    const { erc8004, usdc, registry, credits, gameAnchor, relayer, user1, user2, treasuryAgent } =
      await loadFixture(deployTreasuryFixture);
    const registrations = [
      { signer: user1, name: 'AlphaBot', uri: 'https://alpha.ai' },
      { signer: user2, name: 'BetaBot', uri: 'https://beta.ai' },
      { signer: treasuryAgent, name: 'TournamentTreasury', uri: 'https://treasury.ai' },
    ];
    const agentIds: bigint[] = [];

    for (const registration of registrations) {
      const mintTo = erc8004.getFunction('mintTo');
      const agentId = await mintTo.staticCall(registration.signer.address, registration.uri);
      await mintTo(registration.signer.address, registration.uri);
      agentIds.push(agentId);
      await usdc.getFunction('mint')(registration.signer.address, 5_000_000n);
      await usdc.connect(registration.signer).getFunction('approve')(
        await registry.getAddress(),
        5_000_000n,
      );
      await registry.connect(registration.signer).getFunction('registerExisting')(
        registration.signer.address,
        registration.name,
        agentId,
        0,
        0,
        ethers.ZeroHash,
        ethers.ZeroHash,
      );
    }

    const [agentOne, agentTwo, treasuryAgentId] = agentIds;
    if (agentOne === undefined || agentTwo === undefined || treasuryAgentId === undefined) {
      throw new Error('Expected three registered agents');
    }
    const result = {
      gameId: ethers.id('three-agent-treasury-settlement'),
      gameType: 'tragedy-of-the-commons',
      players: agentIds,
      outcome: '0x01',
      movesRoot: ethers.id('three-agent-moves'),
      configHash: ethers.id('three-agent-config'),
      turnCount: 12,
      timestamp: Math.floor(Date.now() / 1000),
    };
    const deltas = [50_000n, -50_000n, 0n];
    const balances = await Promise.all(
      agentIds.map((agentId) => credits.getFunction('balances')(agentId)),
    );

    await gameAnchor.connect(relayer).getFunction('settleGame')(result, deltas);

    expect(result.players).to.have.length(deltas.length);
    expect(await credits.getFunction('balances')(agentOne)).to.equal((balances[0] ?? 0n) + 50_000n);
    expect(await credits.getFunction('balances')(agentTwo)).to.equal((balances[1] ?? 0n) - 50_000n);
    expect(await credits.getFunction('balances')(treasuryAgentId)).to.equal(balances[2] ?? 0n);

    const invalidResult = { ...result, gameId: ethers.id('three-agent-treasury-invalid') };
    await expect(
      gameAnchor.connect(relayer).getFunction('settleGame')(invalidResult, [50_000n, -50_000n, 1n]),
    ).to.be.revertedWithCustomError(gameAnchor, 'ZeroSumViolation');
    await expect(
      gameAnchor.connect(relayer).getFunction('settleGame')(invalidResult, [50_000n, -50_000n]),
    ).to.be.revertedWithCustomError(gameAnchor, 'LengthMismatch');
  });
});
