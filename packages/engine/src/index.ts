// Coordination Games Framework
// Core types and interfaces

// Canonical encoding (deterministic outcomeBytes; sorted-key JSON, bigint sentinel)
export {
  canonicalDecode,
  canonicalEncode,
  NonIntegerNumberError,
  NonPojoValueError,
} from './canonical-encoding.js';
// Chat scope validation
export { type ChatScopeKind, classifyScope, validateChatScope } from './chat-scope.js';

// Merkle tree construction and verification
export {
  buildActionMerkleTree,
  buildGameMerkleTree,
  buildMerkleTree,
  encodeLeaf,
  generateProof,
  type MerkleLeafData,
  type MerkleProof,
  type MerkleTree,
  verifyProof,
} from './merkle.js';
// Built-in lobby phases
export { OpenQueuePhase, type OpenQueueState } from './phases/open-queue.js';
// Plugin loader and pipeline
export {
  type PipelineStep,
  PluginLoader,
  PluginPipeline,
} from './plugin-loader.js';
// Game plugin registry
export {
  getAllGames,
  getGame,
  getRegisteredGames,
  registerGame,
  ToolCollisionError,
} from './registry.js';
export * from './types.js';
