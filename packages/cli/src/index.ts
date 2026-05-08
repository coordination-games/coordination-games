import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { registerGameCommands } from './commands/game.js';
import { registerInitCommand } from './commands/init.js';
import { registerNameCommands } from './commands/names.js';
import { registerServeCommand } from './commands/serve.js';
import { registerStatusCommand } from './commands/status.js';
import { registerVerifyCommand } from './commands/verify.js';
import { registerWalletCommands } from './commands/wallet.js';

// Injected at build time by esbuild --define. May be undefined when this module
// is imported by tooling (e.g. scripts/gen-cli-reference.ts) running under tsx.
declare const COGA_VERSION: string | undefined;
const VERSION = typeof COGA_VERSION === 'string' && COGA_VERSION ? COGA_VERSION : '0.0.0-dev';

export const program = new Command();

program
  .name('coga')
  .description('Coordination Games — CLI for AI agents and players')
  .version(VERSION);

// Setup & identity
registerInitCommand(program);
registerStatusCommand(program);

// Name registration
registerNameCommands(program);

// Wallet & key management
registerWalletCommands(program);

// Gameplay commands
registerGameCommands(program);

// Game verification (Merkle tree)
registerVerifyCommand(program);

// MCP server mode
registerServeCommand(program);

// Only parse argv when this module is executed directly. When imported by
// tooling (scripts/gen-cli-reference.ts) we want the configured `program`
// without side effects.
//
// We have to handle both runtime shapes:
//   - ESM (tsx dev mode): use `import.meta.url` and compare to argv[1].
//   - Bundled CJS (the published bin): esbuild stubs out `import.meta.url`,
//     but the bundle is loaded as a CommonJS module so `require.main === module`
//     works directly. The `typeof` guards keep TS/strict ESM happy.
function isMainModule(): boolean {
  // CJS path: in the bundled bin, `require.main` and `module` are provided by
  // Node's CJS module wrapper. `typeof` guards keep this safe under strict ESM.
  const cjsRequire = typeof require !== 'undefined' ? require : undefined;
  const cjsModule = typeof module !== 'undefined' ? module : undefined;
  if (cjsRequire && cjsModule && cjsRequire.main === cjsModule) return true;

  // ESM path (tsx dev / direct ESM run): compare module URL to argv[1].
  try {
    const here = fileURLToPath(import.meta.url);
    return Boolean(process.argv[1]) && process.argv[1] === here;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  program.parse(process.argv);
}
