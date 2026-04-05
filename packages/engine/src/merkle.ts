/**
 * Merkle tree construction for game move verification.
 *
 * Builds a binary Merkle tree from turn data (moves + signatures).
 * Used to produce the movesRoot anchored on-chain via GameAnchor.settleGame().
 *
 * Tree structure:
 * - Leaf = keccak256(abi.encodePacked(turnNumber, playerId, moveHash, signature))
 * - Internal nodes = keccak256(sort(left, right))  // sorted to make proofs order-independent
 */

import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Hash helpers (using SHA-256 as a stand-in; in production use keccak256)
// ---------------------------------------------------------------------------

/** Hash a buffer with SHA-256. In production, replace with keccak256. */
function hashBuffer(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/** Hash a string with SHA-256. */
function hashString(data: string): string {
  return hashBuffer(Buffer.from(data, 'utf-8'));
}

/** Hash two child hashes together (sorted for order independence). */
function hashPair(a: string, b: string): string {
  const sorted = [a, b].sort();
  return hashString(sorted[0] + sorted[1]);
}

// ---------------------------------------------------------------------------
// Turn leaf encoding
// ---------------------------------------------------------------------------

export interface MerkleLeafData {
  turnNumber: number;
  playerId: string;
  moveData: string;     // JSON-serialized move
  signature?: string;   // EIP-712 signature (hex string)
}

/** Encode a single move into a Merkle leaf hash. */
export function encodeLeaf(data: MerkleLeafData): string {
  const payload = [
    String(data.turnNumber),
    data.playerId,
    data.moveData,
    data.signature ?? 'unsigned',
  ].join('|');
  return hashString(payload);
}

// ---------------------------------------------------------------------------
// Merkle tree
// ---------------------------------------------------------------------------

export interface MerkleProof {
  leaf: string;
  proof: string[];    // Sibling hashes from leaf to root
  index: number;      // Leaf index in the tree
}

export interface MerkleTree {
  root: string;
  leaves: string[];
  layers: string[][];
}

/**
 * Build a Merkle tree from an array of leaf hashes.
 * Returns the root, all leaves, and intermediate layers for proof generation.
 */
export function buildMerkleTree(leaves: string[]): MerkleTree {
  if (leaves.length === 0) {
    return {
      root: hashString('empty'),
      leaves: [],
      layers: [[]],
    };
  }

  // Ensure even number of leaves by duplicating the last one if odd
  const paddedLeaves = [...leaves];
  if (paddedLeaves.length % 2 !== 0) {
    paddedLeaves.push(paddedLeaves[paddedLeaves.length - 1]);
  }

  const layers: string[][] = [paddedLeaves];
  let currentLayer = paddedLeaves;

  while (currentLayer.length > 1) {
    const nextLayer: string[] = [];
    for (let i = 0; i < currentLayer.length; i += 2) {
      const left = currentLayer[i];
      const right = currentLayer[i + 1] ?? left;
      nextLayer.push(hashPair(left, right));
    }
    layers.push(nextLayer);
    currentLayer = nextLayer;
  }

  return {
    root: currentLayer[0],
    leaves: paddedLeaves,
    layers,
  };
}

/**
 * Generate a Merkle proof for a leaf at the given index.
 */
export function generateProof(tree: MerkleTree, leafIndex: number): MerkleProof {
  if (leafIndex < 0 || leafIndex >= tree.leaves.length) {
    throw new Error(`Leaf index ${leafIndex} out of range [0, ${tree.leaves.length})`);
  }

  const proof: string[] = [];
  let idx = leafIndex;

  for (let layerIdx = 0; layerIdx < tree.layers.length - 1; layerIdx++) {
    const layer = tree.layers[layerIdx];
    const siblingIdx = idx % 2 === 0 ? idx + 1 : idx - 1;

    if (siblingIdx < layer.length) {
      proof.push(layer[siblingIdx]);
    }

    idx = Math.floor(idx / 2);
  }

  return {
    leaf: tree.leaves[leafIndex],
    proof,
    index: leafIndex,
  };
}

/**
 * Verify a Merkle proof against a root.
 */
export function verifyProof(root: string, proof: MerkleProof): boolean {
  let current = proof.leaf;
  let idx = proof.index;

  for (const sibling of proof.proof) {
    current = hashPair(current, sibling);
    idx = Math.floor(idx / 2);
  }

  return current === root;
}

/**
 * Build a Merkle tree from turn data arrays.
 * Each turn may contain multiple player moves; each move becomes a leaf.
 */
export function buildGameMerkleTree(
  turns: { turnNumber: number; moves: MerkleLeafData[] }[],
): MerkleTree {
  const leaves: string[] = [];

  for (const turn of turns) {
    for (const move of turn.moves) {
      leaves.push(encodeLeaf(move));
    }
  }

  return buildMerkleTree(leaves);
}
