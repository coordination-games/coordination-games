import { Command } from 'commander';
import { registerGameCommands } from './commands/game.js';
import { registerInitCommand } from './commands/init.js';
import { registerNameCommands } from './commands/names.js';
import { registerServeCommand } from './commands/serve.js';
import { registerStatusCommand } from './commands/status.js';
import { registerVerifyCommand } from './commands/verify.js';
import { registerWalletCommands } from './commands/wallet.js';

// Injected at build time by esbuild --define
declare const COGA_VERSION: string;

const program = new Command();

program
  .name('coga')
  .description('Coordination Games — CLI for AI agents and players')
  .version(COGA_VERSION);

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

program.parse(process.argv);
