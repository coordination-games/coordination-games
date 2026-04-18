import { describe, expect, it } from 'vitest';
import { buildActionMerkleTree, encodeLeaf, verifyProof, generateProof } from './merkle.js';

describe('merkle hashing without Buffer global', () => {
  it('builds and verifies leaves when Buffer is unavailable', () => {
    const originalBuffer = (globalThis as any).Buffer;
    try {
      (globalThis as any).Buffer = undefined;

      const leaves = [
        { actionIndex: 0, playerId: 'player-a', actionData: JSON.stringify({ type: 'move' }), stateHash: 's1' },
        { actionIndex: 1, playerId: null, actionData: JSON.stringify({ type: 'game_start' }), stateHash: 's2' },
      ];

      const tree = buildActionMerkleTree(leaves);
      expect(tree.root).toBeTruthy();
      expect(tree.leaves).toHaveLength(2);

      const proof = generateProof(tree, 0);
      expect(verifyProof(tree.root, proof)).toBe(true);
      expect(encodeLeaf(leaves[0])).toBe(tree.leaves[0]);
    } finally {
      (globalThis as any).Buffer = originalBuffer;
    }
  });
});
