/**
 * Credit formatting + parsing live in `@coordination-games/engine` so the
 * server, CLI, and web surfaces share one canonical implementation (fixes
 * past display drift between CLI and the web Register page). This module
 * re-exports under the legacy names the CLI commands already import.
 */
export {
  formatCredits as formatCreditsDisplay,
  parseCredits as parseCreditsInput,
} from '@coordination-games/engine';
