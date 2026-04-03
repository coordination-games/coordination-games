/**
 * Relay endpoints — the server acts as a gas-paying relayer for on-chain operations.
 *
 * Agents sign permits/messages locally; the server submits transactions and pays gas.
 */

import express from 'express';
import { ethers } from 'ethers';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ---------------------------------------------------------------------------
// ABI loading — read from compiled contract artifacts
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACTS_DIR = path.resolve(__dirname, '../../contracts/artifacts/contracts');

function loadAbi(contractDir: string, contractName: string): any[] {
  const artifactPath = path.join(ARTIFACTS_DIR, contractDir, `${contractName}.json`);
  const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf-8'));
  return artifact.abi;
}

// ---------------------------------------------------------------------------
// Relay configuration
// ---------------------------------------------------------------------------

export interface RelayConfig {
  rpcUrl: string;
  relayerPrivateKey: string;
  registryAddress: string;
  creditsAddress: string;
  gameAnchorAddress: string;
  usdcAddress: string;
  erc8004Address: string;
}

function getRelayConfig(): RelayConfig | null {
  const rpcUrl = process.env.RPC_URL;
  const relayerPrivateKey = process.env.RELAYER_PRIVATE_KEY;
  const registryAddress = process.env.REGISTRY_ADDRESS;
  const creditsAddress = process.env.CREDITS_ADDRESS;
  const gameAnchorAddress = process.env.GAME_ANCHOR_ADDRESS;
  const usdcAddress = process.env.USDC_ADDRESS;
  const erc8004Address = process.env.ERC8004_ADDRESS;

  if (!rpcUrl || !relayerPrivateKey || !registryAddress || !creditsAddress ||
      !gameAnchorAddress || !usdcAddress || !erc8004Address) {
    return null;
  }

  return {
    rpcUrl,
    relayerPrivateKey,
    registryAddress,
    creditsAddress,
    gameAnchorAddress,
    usdcAddress,
    erc8004Address,
  };
}

// ---------------------------------------------------------------------------
// Create relay router
// ---------------------------------------------------------------------------

export function createRelayRouter(): express.Router | null {
  const config = getRelayConfig();
  if (!config) {
    console.log('[relay] On-chain relay disabled — missing env vars (RPC_URL, RELAYER_PRIVATE_KEY, etc.)');
    return null;
  }

  // Use staticNetwork to prevent ethers from polling eth_chainId/eth_blockNumber repeatedly
  const provider = new ethers.JsonRpcProvider(config.rpcUrl, undefined, { staticNetwork: true });
  const relayerWallet = new ethers.Wallet(config.relayerPrivateKey, provider);

  // Load ABIs
  const registryAbi = loadAbi('CoordinationRegistry.sol', 'CoordinationRegistry');
  const creditsAbi = loadAbi('CoordinationCredits.sol', 'CoordinationCredits');
  const gameAnchorAbi = loadAbi('GameAnchor.sol', 'GameAnchor');
  const usdcAbi = loadAbi('mocks/MockUSDC.sol', 'MockUSDC');  // works for real USDC too (ERC20 + permit)
  const erc8004Abi = loadAbi('mocks/MockERC8004.sol', 'MockERC8004');

  // Contract instances (read-only for queries, relayer wallet for writes)
  const registry = new ethers.Contract(config.registryAddress, registryAbi, relayerWallet);
  const credits = new ethers.Contract(config.creditsAddress, creditsAbi, relayerWallet);
  const gameAnchor = new ethers.Contract(config.gameAnchorAddress, gameAnchorAbi, relayerWallet);
  const usdc = new ethers.Contract(config.usdcAddress, usdcAbi, provider);
  const erc8004 = new ethers.Contract(config.erc8004Address, erc8004Abi, provider);

  const router = express.Router();

  console.log(`[relay] On-chain relay enabled`);
  console.log(`[relay] Relayer address: ${relayerWallet.address}`);
  console.log(`[relay] Registry: ${config.registryAddress}`);
  console.log(`[relay] Credits: ${config.creditsAddress}`);
  console.log(`[relay] GameAnchor: ${config.gameAnchorAddress}`);

  // =========================================================================
  // POST /register — register a new agent or existing agent
  // =========================================================================
  router.post('/register', async (req, res) => {
    try {
      const { name, agentURI, permitDeadline, v, r, s, existingAgentId } = req.body;

      if (!name) {
        return res.status(400).json({ error: 'Missing name' });
      }

      let tx;
      if (existingAgentId !== undefined && existingAgentId !== null) {
        tx = await registry.registerExisting(
          name,
          BigInt(existingAgentId),
          BigInt(permitDeadline || 0),
          v || 0,
          r || ethers.ZeroHash,
          s || ethers.ZeroHash,
        );
      } else {
        tx = await registry.registerNew(
          name,
          agentURI || '',
          BigInt(permitDeadline || 0),
          v || 0,
          r || ethers.ZeroHash,
          s || ethers.ZeroHash,
        );
      }

      const receipt = await tx.wait();

      // Parse Registered event to get agentId
      const registeredEvent = receipt.logs.find((log: any) => {
        try {
          const parsed = registry.interface.parseLog({ topics: log.topics, data: log.data });
          return parsed?.name === 'Registered';
        } catch { return false; }
      });

      let agentId = null;
      if (registeredEvent) {
        const parsed = registry.interface.parseLog({
          topics: registeredEvent.topics,
          data: registeredEvent.data,
        });
        agentId = parsed?.args?.agentId?.toString();
      }

      // Read initial credit balance
      let creditBalance = '0';
      if (agentId) {
        const bal = await credits.balances(BigInt(agentId));
        creditBalance = bal.toString();
      }

      res.json({
        success: true,
        txHash: receipt.hash,
        agentId,
        name,
        credits: creditBalance,
      });
    } catch (err: any) {
      console.error('[relay] register error:', err.message);
      res.status(500).json({ error: err.reason || err.message });
    }
  });

  // =========================================================================
  // POST /topup — mint additional credits by depositing USDC
  // =========================================================================
  router.post('/topup', async (req, res) => {
    try {
      const { agentId, usdcAmount, permitDeadline, v, r, s } = req.body;

      if (agentId === undefined || !usdcAmount) {
        return res.status(400).json({ error: 'Missing agentId or usdcAmount' });
      }

      // The caller should have signed a USDC permit for the credits contract
      const tx = await credits.mint(BigInt(agentId), BigInt(usdcAmount));
      const receipt = await tx.wait();

      const bal = await credits.balances(BigInt(agentId));

      res.json({
        success: true,
        txHash: receipt.hash,
        credits: bal.toString(),
      });
    } catch (err: any) {
      console.error('[relay] topup error:', err.message);
      res.status(500).json({ error: err.reason || err.message });
    }
  });

  // =========================================================================
  // POST /burn-request — request a burn (starts cooldown)
  // =========================================================================
  router.post('/burn-request', async (req, res) => {
    try {
      const { agentId, amount } = req.body;

      if (agentId === undefined || !amount) {
        return res.status(400).json({ error: 'Missing agentId or amount' });
      }

      const tx = await credits.requestBurn(BigInt(agentId), BigInt(amount));
      const receipt = await tx.wait();

      // Read pending burn info
      const pending = await credits.pendingBurns(BigInt(agentId));

      res.json({
        success: true,
        txHash: receipt.hash,
        pendingAmount: pending.amount.toString(),
        executeAfter: pending.executeAfter.toString(),
      });
    } catch (err: any) {
      console.error('[relay] burn-request error:', err.message);
      res.status(500).json({ error: err.reason || err.message });
    }
  });

  // =========================================================================
  // POST /burn-execute — execute a pending burn after cooldown
  // =========================================================================
  router.post('/burn-execute', async (req, res) => {
    try {
      const { agentId } = req.body;

      if (agentId === undefined) {
        return res.status(400).json({ error: 'Missing agentId' });
      }

      const tx = await credits.executeBurn(BigInt(agentId));
      const receipt = await tx.wait();

      const bal = await credits.balances(BigInt(agentId));

      res.json({
        success: true,
        txHash: receipt.hash,
        credits: bal.toString(),
      });
    } catch (err: any) {
      console.error('[relay] burn-execute error:', err.message);
      res.status(500).json({ error: err.reason || err.message });
    }
  });

  // =========================================================================
  // POST /settle — settle a game result on-chain
  // =========================================================================
  router.post('/settle', async (req, res) => {
    try {
      const { gameResult, deltas } = req.body;

      if (!gameResult || !deltas) {
        return res.status(400).json({ error: 'Missing gameResult or deltas' });
      }

      // Convert the result to match the contract struct
      const result = {
        gameId: gameResult.gameId,
        gameType: gameResult.gameType,
        players: gameResult.players.map((p: any) => BigInt(p)),
        outcome: gameResult.outcome,
        movesRoot: gameResult.movesRoot,
        configHash: gameResult.configHash,
        turnCount: gameResult.turnCount,
        timestamp: gameResult.timestamp,
      };

      const deltasBI = deltas.map((d: any) => BigInt(d));

      const tx = await gameAnchor.settleGame(result, deltasBI);
      const receipt = await tx.wait();

      res.json({
        success: true,
        txHash: receipt.hash,
        gameId: gameResult.gameId,
      });
    } catch (err: any) {
      console.error('[relay] settle error:', err.message);
      res.status(500).json({ error: err.reason || err.message });
    }
  });

  // =========================================================================
  // GET /balance/:agentId — read on-chain credit balance
  // =========================================================================
  router.get('/balance/:agentId', async (req, res) => {
    try {
      const agentId = BigInt(req.params.agentId);
      const bal = await credits.balances(agentId);

      // Also try to get USDC balance of the agent owner
      let usdcBalance = '0';
      try {
        const owner = await erc8004.ownerOf(agentId);
        const usdcBal = await usdc.balanceOf(owner);
        usdcBalance = usdcBal.toString();
      } catch {
        // Agent may not exist
      }

      res.json({
        agentId: agentId.toString(),
        credits: bal.toString(),
        usdc: usdcBalance,
      });
    } catch (err: any) {
      console.error('[relay] balance error:', err.message);
      res.status(500).json({ error: err.reason || err.message });
    }
  });

  // =========================================================================
  // GET /check-name/:name — check name availability on-chain
  // =========================================================================
  router.get('/check-name/:name', async (req, res) => {
    try {
      const name = req.params.name;
      const available = await registry.checkName(name);

      res.json({
        name,
        available,
      });
    } catch (err: any) {
      console.error('[relay] check-name error:', err.message);
      res.status(500).json({ error: err.reason || err.message });
    }
  });

  // =========================================================================
  // GET /status/:address — check registration status for an address
  // =========================================================================
  router.get('/status/:address', async (req, res) => {
    try {
      const address = req.params.address;

      // We need to scan for registered agents owned by this address.
      // Since there's no reverse mapping on-chain, we check a reasonable range.
      // For local testing, agent IDs start at 1 and are sequential.
      let registered = false;
      let agentId = null;
      let name = null;
      let creditBalance = '0';

      // Check agent IDs 1-100 (sufficient for local testing / early production)
      for (let id = 1; id <= 100; id++) {
        try {
          const owner = await erc8004.ownerOf(id);
          if (owner.toLowerCase() === address.toLowerCase()) {
            const isReg = await registry.registered(id);
            if (isReg) {
              registered = true;
              agentId = id.toString();
              name = await registry.displayName(id);
              const bal = await credits.balances(id);
              creditBalance = bal.toString();
              break;
            }
          }
        } catch {
          // Agent doesn't exist at this ID, skip
          break; // IDs are sequential, so if one doesn't exist, stop
        }
      }

      res.json({
        address,
        registered,
        agentId,
        name,
        credits: creditBalance,
      });
    } catch (err: any) {
      console.error('[relay] status error:', err.message);
      res.status(500).json({ error: err.reason || err.message });
    }
  });

  // =========================================================================
  // POST /attest — relay attestation to EAS on Optimism (TrustGraph)
  // =========================================================================
  router.post('/attest', async (req, res) => {
    try {
      const { attester, recipient, confidence, context, signature, schemaUid } = req.body;

      if (!attester || !recipient || confidence == null || !signature) {
        return res.status(400).json({ error: 'Missing required fields: attester, recipient, confidence, signature' });
      }

      if (confidence < 1 || confidence > 100) {
        return res.status(400).json({ error: 'Confidence must be 1-100' });
      }

      // Verify the EIP-712 signature matches the attester
      const domain = {
        name: 'Coordination TrustGraph',
        version: '1',
        chainId: 10,
      };
      const types = {
        Attestation: [
          { name: 'recipient', type: 'uint256' },
          { name: 'confidence', type: 'uint256' },
          { name: 'context', type: 'string' },
        ],
      };
      const message = { recipient, confidence, context: context || '' };

      const recoveredAddress = ethers.verifyTypedData(domain, types, message, signature);
      if (recoveredAddress.toLowerCase() !== attester.toLowerCase()) {
        return res.status(403).json({ error: 'Signature does not match attester' });
      }

      // EAS contract on Optimism
      const EAS_ADDRESS = '0x4200000000000000000000000000000000000021';
      const EAS_ABI = [
        'function attest((bytes32 schema, (address recipient, uint64 expirationTime, bool revocable, bytes32 refUID, bytes data, uint256 value) data) request) external payable returns (bytes32)',
      ];
      const eas = new ethers.Contract(EAS_ADDRESS, EAS_ABI, relayerWallet);

      // Encode the attestation data: (uint256 confidence, string context)
      const encodedData = ethers.AbiCoder.defaultAbiCoder().encode(
        ['uint256', 'string'],
        [confidence, context || '']
      );

      // Convert recipient agentId to an address-like format for EAS
      // EAS expects an address as recipient; we use the agent's owner address
      // For now, pad the agentId to address format
      const recipientAddress = ethers.zeroPadValue(ethers.toBeHex(BigInt(recipient)), 20);

      const attestRequest = {
        schema: schemaUid || ethers.ZeroHash,
        data: {
          recipient: recipientAddress,
          expirationTime: 0n, // No expiration
          revocable: true,
          refUID: ethers.ZeroHash,
          data: encodedData,
          value: 0n,
        },
      };

      const tx = await eas.attest(attestRequest);
      const receipt = await tx.wait();

      // Extract attestation UID from receipt logs
      let attestationUid = null;
      if (receipt && receipt.logs && receipt.logs.length > 0) {
        // The first log typically contains the attestation UID as the first topic
        attestationUid = receipt.logs[0]?.topics?.[1] || null;
      }

      // Fallback: compute deterministic UID
      if (!attestationUid) {
        attestationUid = ethers.keccak256(
          ethers.AbiCoder.defaultAbiCoder().encode(
            ['address', 'uint256', 'uint256', 'string', 'uint256'],
            [attester, recipient, confidence, context || '', Math.floor(Date.now() / 1000)]
          )
        );
      }

      console.log(`[relay] EAS attestation from ${attester} for agent ${recipient}: confidence=${confidence}, uid=${attestationUid}`);

      res.json({
        attestationUid,
        txHash: receipt?.hash || null,
        status: 'confirmed',
      });
    } catch (err: any) {
      console.error('[relay] attest error:', err.message);

      // If the on-chain tx fails (e.g., wrong schema UID, no gas), fall back to local mock
      if (err.message?.includes('CALL_EXCEPTION') || err.message?.includes('insufficient')) {
        const attestationUid = ethers.keccak256(
          ethers.AbiCoder.defaultAbiCoder().encode(
            ['address', 'uint256', 'uint256', 'string', 'uint256'],
            [req.body.attester, req.body.recipient, req.body.confidence, req.body.context || '', Math.floor(Date.now() / 1000)]
          )
        );
        console.log(`[relay] Falling back to local attestation mock: ${attestationUid}`);
        return res.json({
          attestationUid,
          txHash: null,
          status: 'local',
        });
      }

      res.status(500).json({ error: err.reason || err.message });
    }
  });

  // =========================================================================
  // POST /revoke — revoke an EAS attestation (TrustGraph)
  // =========================================================================
  router.post('/revoke', async (req, res) => {
    try {
      const { attester, attestationUid, signature, schemaUid } = req.body;

      if (!attester || !attestationUid || !signature) {
        return res.status(400).json({ error: 'Missing required fields: attester, attestationUid, signature' });
      }

      // Verify the EIP-712 signature
      const domain = {
        name: 'Coordination TrustGraph',
        version: '1',
        chainId: 10,
      };
      const types = {
        Revocation: [
          { name: 'attestationUid', type: 'bytes32' },
        ],
      };
      const message = { attestationUid };

      const recoveredAddress = ethers.verifyTypedData(domain, types, message, signature);
      if (recoveredAddress.toLowerCase() !== attester.toLowerCase()) {
        return res.status(403).json({ error: 'Signature does not match attester' });
      }

      // EAS revoke on-chain
      const EAS_ADDRESS = '0x4200000000000000000000000000000000000021';
      const EAS_ABI = [
        'function revoke((bytes32 schema, (bytes32 uid, uint256 value) data) request) external payable',
      ];
      const eas = new ethers.Contract(EAS_ADDRESS, EAS_ABI, relayerWallet);

      const revokeRequest = {
        schema: schemaUid || ethers.ZeroHash,
        data: {
          uid: attestationUid,
          value: 0n,
        },
      };

      const tx = await eas.revoke(revokeRequest);
      const receipt = await tx.wait();

      console.log(`[relay] EAS revocation from ${attester} for attestation ${attestationUid}`);

      res.json({
        txHash: receipt?.hash || null,
        status: 'confirmed',
      });
    } catch (err: any) {
      console.error('[relay] revoke error:', err.message);

      // Fall back to local mock on failure
      if (err.message?.includes('CALL_EXCEPTION') || err.message?.includes('insufficient')) {
        console.log(`[relay] Falling back to local revocation mock`);
        return res.json({ txHash: null, status: 'local' });
      }

      res.status(500).json({ error: err.reason || err.message });
    }
  });

  // =========================================================================
  // GET /reputation/:agentId — query attestations from EAS GraphQL
  // =========================================================================
  router.get('/reputation/:agentId', async (req, res) => {
    try {
      const agentId = req.params.agentId;
      const EAS_GRAPHQL = 'https://optimism.easscan.org/graphql';

      // Query EAS GraphQL for attestations about this agent
      const query = `
        query GetAttestations($recipient: String!) {
          attestations(
            where: {
              recipient: { equals: $recipient }
              revoked: { equals: false }
            }
            orderBy: { time: desc }
            take: 50
          ) {
            id
            attester
            recipient
            time
            decodedDataJson
            revoked
          }
        }
      `;

      // Convert agentId to address format (EAS stores recipient as address)
      const recipientAddress = ethers.zeroPadValue(ethers.toBeHex(BigInt(agentId)), 20);

      let attestations: any[] = [];

      try {
        const gqlRes = await fetch(EAS_GRAPHQL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query,
            variables: { recipient: recipientAddress },
          }),
        });

        if (gqlRes.ok) {
          const data = await gqlRes.json() as any;
          attestations = data?.data?.attestations || [];
        }
      } catch {
        // GraphQL query failed — return empty results
      }

      // Parse attestation data
      const parsed = attestations.map((a: any) => {
        let confidence = 0;
        let context = '';
        try {
          const decoded = JSON.parse(a.decodedDataJson);
          confidence = Number(decoded?.[0]?.value?.value || 0);
          context = String(decoded?.[1]?.value?.value || '');
        } catch {}
        return {
          attester: a.attester,
          confidence,
          context,
          time: a.time,
          uid: a.id,
        };
      });

      const totalAttestations = parsed.length;
      const averageConfidence = totalAttestations > 0
        ? parsed.reduce((sum: number, a: any) => sum + a.confidence, 0) / totalAttestations
        : null;

      res.json({
        agentId,
        totalAttestations,
        averageConfidence,
        recentAttestors: parsed.slice(0, 10),
      });
    } catch (err: any) {
      console.error('[relay] reputation error:', err.message);
      res.status(500).json({ error: err.reason || err.message });
    }
  });

  return router;
}
