import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export {
  BootstrapInputError,
  buildWranglerCommands,
  type LocalBootstrapOptions,
  parseBootstrapOptions,
  type WranglerCommands,
} from './local-bootstrap-options.js';
export {
  hasAuthNoncesTable,
  type LocalBootstrap,
  startLocalBootstrap,
  startUnmigratedLocalWorker,
} from './local-bootstrap-runtime.js';

import { parseBootstrapOptions } from './local-bootstrap-options.js';
import { startLocalBootstrap } from './local-bootstrap-runtime.js';

async function main(): Promise<void> {
  const scriptDirectory = dirname(fileURLToPath(import.meta.url));
  const repositoryRoot = resolve(scriptDirectory, '../../..');
  const bootstrap = await startLocalBootstrap(
    parseBootstrapOptions(process.argv.slice(2), repositoryRoot),
    repositoryRoot,
    resolve(scriptDirectory, '../wrangler.toml'),
  );
  process.stdout.write(bootstrap.migrationOutput);
  process.stdout.write(`Local Wrangler started on http://127.0.0.1:${bootstrap.port}\n`);
  const stop = async (): Promise<void> => {
    await bootstrap.stop();
    process.exit(0);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `local bootstrap failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
