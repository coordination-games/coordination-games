// Coordination Games Framework
// Core types and interfaces
export * from './types.js';

// Merkle tree construction and verification
export {
  buildMerkleTree,
  buildGameMerkleTree,
  generateProof,
  verifyProof,
  encodeLeaf,
  type MerkleTree,
  type MerkleProof,
  type MerkleLeafData,
} from './merkle.js';

// Server-side framework
export {
  GameFramework,
  AuthManager,
  BalanceTracker,
  createGameRoom,
  submitMove,
  allMovesSubmitted,
  resolveTurn,
  buildGameResult,
  computePayouts,
  type GameRoom,
  type AuthConfig,
  type BalanceConfig,
} from './server/index.js';
