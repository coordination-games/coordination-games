// Coordination Games Framework
// Core types and interfaces
export * from './types.js';

// Merkle tree construction and verification
export {
  buildMerkleTree,
  buildActionMerkleTree,
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

// Game room (v2 action-based)
export { GameRoom } from './game-session.js';

// Server-side framework
export {
  GameFramework,
  AuthManager,
  BalanceTracker,
  buildGameResult,
  LobbyPipeline,
  type AuthConfig,
  type BalanceConfig,
} from './server/index.js';
