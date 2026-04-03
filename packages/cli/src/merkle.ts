/**
 * Merkle tree library for game move verification.
 *
 * Builds a binary Merkle tree from turn data, where each leaf is
 * keccak256(abi.encode(turnNumber, moves)). Used by both the server
 * (when calling settleGame) and the verification CLI tool.
 */

import { ethers } from "ethers";

// -------------------------------------------------------------------------
// Types
// -------------------------------------------------------------------------

export interface MoveData {
  player: string;   // address
  data: string;     // game-specific move data (JSON string or hex bytes)
  signature: string; // EIP-712 signature
}

export interface TurnData {
  turnNumber: number;
  moves: MoveData[];
  result?: any;     // resolved state after this turn (optional, not included in Merkle leaf)
}

export interface MerkleTree {
  leaves: string[];     // leaf hashes (one per turn)
  layers: string[][];   // tree layers from leaves to root
  root: string;         // the Merkle root hash
}

// -------------------------------------------------------------------------
// Leaf hashing
// -------------------------------------------------------------------------

/**
 * Compute the leaf hash for a single turn.
 * leaf = keccak256(abi.encode(turnNumber, encodedMoves))
 *
 * Moves are sorted by player address for deterministic ordering.
 */
export function hashTurnLeaf(turn: TurnData): string {
  // Sort moves by player address (lowercase) for determinism
  const sortedMoves = [...turn.moves].sort((a, b) =>
    a.player.toLowerCase().localeCompare(b.player.toLowerCase())
  );

  // Encode each move: abi.encode(player, data, signature)
  const encodedMoves = sortedMoves.map((m) =>
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "bytes", "bytes"],
      [m.player, ethers.toUtf8Bytes(m.data), m.signature]
    )
  );

  // Concatenate all encoded moves
  const movesConcat = ethers.concat(encodedMoves.map((e) => ethers.getBytes(e)));

  // Final leaf = keccak256(abi.encode(turnNumber, movesHash))
  const movesHash = ethers.keccak256(movesConcat);
  const leaf = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint256", "bytes32"],
      [turn.turnNumber, movesHash]
    )
  );

  return leaf;
}

// -------------------------------------------------------------------------
// Tree construction
// -------------------------------------------------------------------------

/**
 * Build a binary Merkle tree from an array of turn data.
 */
export function buildMerkleTree(turns: TurnData[]): MerkleTree {
  if (turns.length === 0) {
    const emptyRoot = ethers.ZeroHash;
    return { leaves: [], layers: [[]], root: emptyRoot };
  }

  // Compute leaf hashes
  const leaves = turns.map(hashTurnLeaf);

  // Build layers bottom-up
  const layers: string[][] = [leaves];
  let currentLayer = leaves;

  while (currentLayer.length > 1) {
    const nextLayer: string[] = [];

    for (let i = 0; i < currentLayer.length; i += 2) {
      if (i + 1 < currentLayer.length) {
        // Hash pair — sort to ensure consistent ordering
        const [left, right] = sortPair(currentLayer[i], currentLayer[i + 1]);
        nextLayer.push(hashPair(left, right));
      } else {
        // Odd node — promote to next layer
        nextLayer.push(currentLayer[i]);
      }
    }

    layers.push(nextLayer);
    currentLayer = nextLayer;
  }

  return {
    leaves,
    layers,
    root: currentLayer[0],
  };
}

// -------------------------------------------------------------------------
// Proof generation
// -------------------------------------------------------------------------

/**
 * Get the Merkle proof for a specific turn index.
 */
export function getProof(tree: MerkleTree, turnIndex: number): string[] {
  if (turnIndex < 0 || turnIndex >= tree.leaves.length) {
    throw new Error(`Turn index ${turnIndex} out of range (0-${tree.leaves.length - 1})`);
  }

  const proof: string[] = [];
  let index = turnIndex;

  for (let layerIdx = 0; layerIdx < tree.layers.length - 1; layerIdx++) {
    const layer = tree.layers[layerIdx];
    const isRight = index % 2 === 1;
    const siblingIndex = isRight ? index - 1 : index + 1;

    if (siblingIndex < layer.length) {
      proof.push(layer[siblingIndex]);
    }

    // Move up to parent index
    index = Math.floor(index / 2);
  }

  return proof;
}

// -------------------------------------------------------------------------
// Proof verification
// -------------------------------------------------------------------------

/**
 * Verify a Merkle proof for a given leaf against a root.
 */
export function verifyProof(root: string, leaf: string, proof: string[]): boolean {
  let current = leaf;

  for (const sibling of proof) {
    const [left, right] = sortPair(current, sibling);
    current = hashPair(left, right);
  }

  return current.toLowerCase() === root.toLowerCase();
}

// -------------------------------------------------------------------------
// Utilities
// -------------------------------------------------------------------------

function sortPair(a: string, b: string): [string, string] {
  return a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
}

function hashPair(left: string, right: string): string {
  return ethers.keccak256(
    ethers.concat([ethers.getBytes(left), ethers.getBytes(right)])
  );
}
