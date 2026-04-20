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

// Chat scope validation
export { validateChatScope, classifyScope, type ChatScopeKind } from './chat-scope.js';
