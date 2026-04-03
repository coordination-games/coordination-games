#!/usr/bin/env node

import { Command } from "commander";
import { registerInitCommand } from "./commands/init.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerNameCommands } from "./commands/names.js";
import { registerWalletCommands } from "./commands/wallet.js";
import { registerServeCommand } from "./commands/serve.js";
import { registerGameCommands } from "./commands/game.js";
import { registerTrustCommands } from "./commands/trust.js";
import { registerVerifyCommand } from "./commands/verify.js";

const program = new Command();

program
  .name("coga")
  .description("Coordination Games — CLI for AI agents and players")
  .version("0.1.0");

// Setup & identity
registerInitCommand(program);
registerStatusCommand(program);

// Name registration
registerNameCommands(program);

// Wallet & key management
registerWalletCommands(program);

// Gameplay commands
registerGameCommands(program);

// Trust & reputation (EAS/TrustGraph)
registerTrustCommands(program);

// Game verification (Merkle tree)
registerVerifyCommand(program);

// MCP server mode
registerServeCommand(program);

program.parse();
