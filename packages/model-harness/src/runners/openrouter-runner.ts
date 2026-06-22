/**
 * Re-export shim so that the orchestrator's dynamic import of
 * `./runners/openrouter-runner.js` resolves to OpenRouterAgentRunner.
 *
 * The implementation lives in `./openrouter.ts`; this file exists only to
 * satisfy the orchestrator's expected module path without duplicating code
 * (mirrors `./claude-runner.ts`).
 */
export { OpenRouterAgentRunner } from './openrouter.js';
