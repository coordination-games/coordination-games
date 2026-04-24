/**
 * Merkle tree tests — keccak256 (Phase 3.4).
 *
 * Locks the engine's hash algorithm against on-chain (EVM) keccak256 so the
 * `movesRoot` we anchor via GameAnchor.settleGame() cannot drift. Vectors are
 * stored as JSON in `merkle-vectors.json` and were generated from this very
 * implementation — the point is to catch *future* regressions, not to
 * cross-check against a reference today.
 */

import { keccak256, stringToBytes, toBytes } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  buildMerkleTree,
  encodeLeaf,
  generateProof,
  type MerkleLeafData,
  verifyProof,
} from '../merkle.js';
import vectors from './merkle-vectors.json' with { type: 'json' };

interface Vector {
  name: string;
  actions: MerkleLeafData[];
  leaves: string[];
  root: string;
}

const ZERO_HASH = `0x${'0'.repeat(64)}`;

describe('merkle vectors (keccak256)', () => {
  for (const v of vectors as Vector[]) {
    it(`vector "${v.name}" — recomputes leaves and root`, () => {
      const computedLeaves = v.actions.map(encodeLeaf);
      expect(computedLeaves).toEqual(v.leaves);

      const tree = buildMerkleTree(computedLeaves);
      expect(tree.root).toBe(v.root);
    });
  }
});

describe('merkle empty-tree behaviour', () => {
  it('empty leaves → 32-byte zero hash', () => {
    const tree = buildMerkleTree([]);
    expect(tree.root).toBe(ZERO_HASH);
    // 0x + 64 hex chars = 66
    expect(tree.root).toHaveLength(66);
  });
});

describe('merkle single-leaf tree', () => {
  it('single leaf is keccak256(leaf || leaf) (last-leaf duplication)', () => {
    // The implementation pads odd-length layers by duplicating the last leaf,
    // so a 1-leaf tree's root is keccak256(concat(leafBytes, leafBytes)).
    // Sorted-pair hashing is a no-op here because both sides are identical.
    const leaf = encodeLeaf({
      actionIndex: 0,
      playerId: 'solo',
      actionData: 'hello',
    });

    const tree = buildMerkleTree([leaf]);

    const leafBytes = toBytes(leaf);
    const concat = new Uint8Array(leafBytes.length * 2);
    concat.set(leafBytes, 0);
    concat.set(leafBytes, leafBytes.length);
    const expected = keccak256(concat);

    expect(tree.root).toBe(expected);
  });

  it('encodeLeaf returns keccak256 of the canonical payload string', () => {
    const data: MerkleLeafData = {
      actionIndex: 7,
      playerId: 'p1',
      actionData: '{"foo":"bar"}',
      stateHash: 'sh',
    };
    const payload = `${data.actionIndex}|${data.playerId}|${data.actionData}|${data.stateHash}`;
    expect(encodeLeaf(data)).toBe(keccak256(stringToBytes(payload)));
  });
});

describe('merkle proof roundtrip', () => {
  // Use the largest vector (7 leaves) so we exercise multi-layer proofs.
  const seven = (vectors as Vector[]).find((v) => v.name === 'seven');
  if (!seven) throw new Error('test fixture missing "seven" vector');

  const tree = buildMerkleTree(seven.leaves);

  for (let i = 0; i < seven.leaves.length; i++) {
    it(`proof for leaf ${i} verifies against root`, () => {
      const proof = generateProof(tree, i);
      expect(verifyProof(tree.root, proof)).toBe(true);
    });
  }

  it('tampered proof fails verification', () => {
    const proof = generateProof(tree, 0);
    const tampered = {
      ...proof,
      // Flip a bit in the leaf
      leaf: proof.leaf.replace(/.$/, (c) => (c === 'f' ? '0' : 'f')),
    };
    expect(verifyProof(tree.root, tampered)).toBe(false);
  });
});
