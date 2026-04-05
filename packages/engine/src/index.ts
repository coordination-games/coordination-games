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

// Plugin loader and pipeline
export {
  PluginLoader,
  PluginPipeline,
  type PipelineStep,
} from './plugin-loader.js';

// Platform MCP — phase-aware tool visibility
export {
  getAvailableTools,
  generateGuide,
  PHASE_TOOLS,
} from './mcp.js';

// Generic game session
export { GameSession } from './game-session.js';

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
  LobbyPipeline,
  type GameRoom,
  type AuthConfig,
  type BalanceConfig,
} from './server/index.js';
