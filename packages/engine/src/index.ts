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

// Game plugin registry
export {
  registerGame,
  getGame,
  getRegisteredGames,
  getAllGames,
  ToolCollisionError,
} from './registry.js';

// Built-in lobby phases
export { OpenQueuePhase, type OpenQueueState } from './phases/open-queue.js';

// Server-side framework
export {
  GameFramework,
  AuthManager,
  BalanceTracker,
  buildGameResult,
  type AuthConfig,
  type BalanceConfig,
} from './server/index.js';
