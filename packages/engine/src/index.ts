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
// Credit decimal scaling (6 decimals, matching USDC)
export { CREDIT_DECIMALS, CREDIT_SCALE } from './money.js';
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
// Relay envelope validation registry (Phase 4.2)
export {
  clearRelayRegistry,
  isRelayTypeRegistered,
  RelayUnknownTypeError,
  RelayValidationError,
  registerPluginRelayTypes,
  registerRelayType,
  type ValidatedRelayEnvelope,
  validateRelay,
  validateRelayBody,
} from './relay-registry.js';
export * from './types.js';
