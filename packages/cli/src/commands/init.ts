import { Command } from "commander";
import { loadKey, generateKey, saveKey, checkPermissions } from "../keys.js";
import { loadConfig, saveConfig, DEFAULT_SERVER_URL } from "../config.js";

export function registerInitCommand(program: Command) {
  program
    .command("init")
    .description("Initialize coordination identity — generate key and save config")
    .option("--key-mode <mode>", "Key management mode: local or waap", "local")
    .option("--server <url>", "Server URL", DEFAULT_SERVER_URL)
    .action(async (opts) => {
      const existing = loadKey();

      if (existing) {
        const perms = checkPermissions();
        process.stdout.write(`\n  Existing identity found\n`);
        process.stdout.write(`  Address: ${existing.address}\n`);
        if (perms.warning) {
          process.stderr.write(`  ${perms.warning}\n`);
        }
        process.stdout.write(`\n  To generate a new key, delete ~/.coordination/keys/default.json and run init again.\n\n`);
        return;
      }

      if (opts.keyMode === "waap") {
        process.stdout.write(`\n  WAAP mode is not yet supported. Use --key-mode local.\n\n`);
        return;
      }

      const wallet = generateKey();
      saveKey(wallet);

      const config = {
        serverUrl: opts.server,
        keyMode: opts.keyMode as "local" | "waap",
      };
      saveConfig(config);

      process.stdout.write(`\n  Identity created!\n`);
      process.stdout.write(`  Address:  ${wallet.address}\n`);
      process.stdout.write(`  Key file: ~/.coordination/keys/default.json\n`);
      process.stdout.write(`  Server:   ${config.serverUrl}\n`);
      process.stdout.write(`  Key mode: ${config.keyMode}\n`);
      process.stdout.write(`\n  Next: coordination register <name>\n\n`);
    });
}
