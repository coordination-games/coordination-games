import { ethers } from "ethers";

// Optimism chain ID
const OPTIMISM_CHAIN_ID = 10;

export interface SignatureResult {
  signature: string;
  v: number;
  r: string;
  s: string;
}

function splitSignature(sig: string): SignatureResult {
  const split = ethers.Signature.from(sig);
  return {
    signature: sig,
    v: split.v,
    r: split.r,
    s: split.s,
  };
}

/**
 * Sign an ERC-2612 USDC permit
 */
export async function signPermit(
  wallet: ethers.Wallet,
  tokenAddress: string,
  spender: string,
  value: bigint,
  deadline: number,
  chainId: number = OPTIMISM_CHAIN_ID,
  nonce: number = 0
): Promise<SignatureResult> {
  const domain: ethers.TypedDataDomain = {
    name: "USD Coin",
    version: "2",
    chainId,
    verifyingContract: tokenAddress,
  };

  const types = {
    Permit: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
      { name: "value", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  };

  const message = {
    owner: wallet.address,
    spender,
    value,
    nonce,
    deadline,
  };

  const sig = await wallet.signTypedData(domain, types, message);
  return splitSignature(sig);
}

/**
 * Generic EIP-712 signing wrapper
 */
export async function signTypedData(
  wallet: ethers.Wallet,
  domain: ethers.TypedDataDomain,
  types: Record<string, ethers.TypedDataField[]>,
  value: Record<string, any>
): Promise<SignatureResult> {
  const sig = await wallet.signTypedData(domain, types, value);
  return splitSignature(sig);
}

/**
 * Sign an auth challenge nonce for server authentication
 */
export async function signAuthChallenge(
  wallet: ethers.Wallet,
  nonce: string,
  serverUrl: string
): Promise<SignatureResult> {
  const domain: ethers.TypedDataDomain = {
    name: "Coordination Games",
    version: "1",
    chainId: OPTIMISM_CHAIN_ID,
  };

  const types = {
    AuthChallenge: [
      { name: "nonce", type: "string" },
      { name: "serverUrl", type: "string" },
    ],
  };

  const message = { nonce, serverUrl };

  const sig = await wallet.signTypedData(domain, types, message);
  return splitSignature(sig);
}

/**
 * Sign a game move with game-specific EIP-712 schema
 */
export async function signMove(
  wallet: ethers.Wallet,
  gameId: string,
  turnNumber: number,
  moveData: Record<string, any>,
  moveSchema: Record<string, ethers.TypedDataField[]>
): Promise<SignatureResult> {
  const domain: ethers.TypedDataDomain = {
    name: "Coordination Games",
    version: "1",
    chainId: OPTIMISM_CHAIN_ID,
    // No verifyingContract — off-chain game moves
  };

  // Merge gameId and turnNumber into the move data
  const fullMoveData = {
    gameId: ethers.id(gameId), // hash the gameId to bytes32
    turnNumber,
    ...moveData,
  };

  const sig = await wallet.signTypedData(domain, moveSchema, fullMoveData);
  return splitSignature(sig);
}
