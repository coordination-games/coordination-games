/**
 * Re-export shim so that the orchestrator's dynamic import of
 * `./runners/claude-runner.js` resolves to ClaudeAgentRunner.
 *
 * The implementation lives in `./claude.ts`; this file exists only to satisfy
 * the orchestrator's expected module path without duplicating code.
 */
export { ClaudeAgentRunner } from './claude.js';
