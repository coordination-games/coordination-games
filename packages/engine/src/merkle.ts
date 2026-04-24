/**
 * Merkle tree construction for game action verification.
 *
 * Builds a binary Merkle tree from action data. Hashing uses keccak256 so the
 * computed root matches what EVM contracts produce on-chain — that root is
 * anchored via GameAnchor.settleGame() and verified by spectators / the
 * `verify` CLI.
 *
 * Tree structure:
 * - Leaf = keccak256(actionIndex | playerId | actionData | stateHash)
 * - Internal nodes = keccak256(sort(left, right))  // sorted to make proofs order-independent
 *
 * Hashes are returned as `0x`-prefixed lowercase hex strings (32 bytes / 66
 * chars). The empty tree's root is the 32-byte zero hash; the on-chain
 * `MissingMovesRoot` check intentionally rejects this so empty games cannot
 * settle silently.
 */

import { keccak256, stringToBytes, toBytes } from 'viem';

// ---------------------------------------------------------------------------
// Hash helpers
// ---------------------------------------------------------------------------

/** 32-byte zero hash (`0x` + 64 zeros). Used as the empty-tree root. */
const ZERO_HASH = `0x${'0'.repeat(64)}` as const;

/** Hash a UTF-8 string with keccak256, returning `0x`-prefixed hex. */
function hashString(data: string): string {
  return keccak256(stringToBytes(data));
}

/**
 * Hash two child hashes together (sorted for order independence).
 *
 * Children are concatenated as raw 32-byte buffers, matching how Solidity
 * `keccak256(abi.encodePacked(left, right))` operates over `bytes32` values.
 */
function hashPair(a: string, b: string): string {
  const [left, right] = a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
  const leftBytes = toBytes(left);
  const rightBytes = toBytes(right);
  const concat = new Uint8Array(leftBytes.length + rightBytes.length);
  concat.set(leftBytes, 0);
  concat.set(rightBytes, leftBytes.length);
  return keccak256(concat);
}

// ---------------------------------------------------------------------------
// Turn leaf encoding
// ---------------------------------------------------------------------------

export interface MerkleLeafData {
  actionIndex: number; // sequential action number
  playerId: string | null; // null for system actions
  actionData: string; // JSON.stringify of the action
  stateHash?: string; // hash of resulting state (optional)
}

/** Encode a single action into a Merkle leaf hash. */
export function encodeLeaf(data: MerkleLeafData): string {
  const payload = [
    String(data.actionIndex),
    data.playerId ?? 'system',
    data.actionData,
    data.stateHash ?? 'none',
  ].join('|');
  return hashString(payload);
}

// ---------------------------------------------------------------------------
// Merkle tree
// ---------------------------------------------------------------------------

export interface MerkleProof {
  leaf: string;
  proof: string[]; // Sibling hashes from leaf to root
  index: number; // Leaf index in the tree
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
      root: ZERO_HASH,
      leaves: [],
      layers: [[]],
    };
  }

  // Ensure even number of leaves by duplicating the last one if odd
  const paddedLeaves = [...leaves];
  if (paddedLeaves.length % 2 !== 0) {
    const last = paddedLeaves[paddedLeaves.length - 1];
    if (last === undefined) throw new Error('unreachable: odd-length array has a last element');
    paddedLeaves.push(last);
  }

  const layers: string[][] = [paddedLeaves];
  let currentLayer = paddedLeaves;

  while (currentLayer.length > 1) {
    const nextLayer: string[] = [];
    for (let i = 0; i < currentLayer.length; i += 2) {
      const left = currentLayer[i];
      const right = currentLayer[i + 1] ?? left;
      if (left === undefined || right === undefined) {
        throw new Error('unreachable: even-length layer iteration');
      }
      nextLayer.push(hashPair(left, right));
    }
    layers.push(nextLayer);
    currentLayer = nextLayer;
  }

  const root = currentLayer[0];
  if (root === undefined) throw new Error('unreachable: terminal layer must have one node');
  return {
    root,
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
    if (layer === undefined) throw new Error('unreachable: layer index in range');
    const siblingIdx = idx % 2 === 0 ? idx + 1 : idx - 1;

    if (siblingIdx < layer.length) {
      const sibling = layer[siblingIdx];
      if (sibling === undefined) throw new Error('unreachable: sibling index in range');
      proof.push(sibling);
    }

    idx = Math.floor(idx / 2);
  }

  const leaf = tree.leaves[leafIndex];
  if (leaf === undefined) throw new Error('unreachable: leafIndex bounded above');
  return {
    leaf,
    proof,
    index: leafIndex,
  };
}

/**
 * Verify a Merkle proof against a root.
 */
export function verifyProof(root: string, proof: MerkleProof): boolean {
  let current = proof.leaf;

  for (const sibling of proof.proof) {
    current = hashPair(current, sibling);
  }

  return current.toLowerCase() === root.toLowerCase();
}

/**
 * Build a Merkle tree from an action log.
 * Each action becomes a leaf in sequential order.
 */
export function buildActionMerkleTree(actions: MerkleLeafData[]): MerkleTree {
  const leaves: string[] = actions.map((action) => encodeLeaf(action));
  return buildMerkleTree(leaves);
}

/**
 * @deprecated Use buildActionMerkleTree instead. Kept for v1 compatibility during migration.
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
