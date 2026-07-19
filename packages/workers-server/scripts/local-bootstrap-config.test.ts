import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeRuntimeConfig } from './local-bootstrap-config.js';

describe('local bootstrap runtime config', () => {
  let runtimeDirectory: string | undefined;

  afterEach(async () => {
    if (runtimeDirectory) await rm(runtimeDirectory, { recursive: true, force: true });
    runtimeDirectory = undefined;
  });

  it('adds the deterministic inspector token only to the generated isolated config', async () => {
    runtimeDirectory = await mkdtemp(resolve(tmpdir(), 'coga-runtime-config-'));

    const runtimeConfigPath = await writeRuntimeConfig(
      runtimeDirectory,
      '/repository/packages/workers-server/wrangler.toml',
    );
    const config = await readFile(runtimeConfigPath, 'utf8');

    expect(runtimeConfigPath).toBe(resolve(runtimeDirectory, 'wrangler.toml'));
    expect(config).toContain('ADMIN_TOKEN = "local-inspector-token"');
    expect(config).toContain('STRICT_LOCAL_SETTLEMENT = "true"');
    expect(config).toContain('TREASURY_AGENT_HANDLE = "local-tournament-treasury"');
    expect(config).not.toContain('.dev.vars');
    expect(config).not.toContain('RPC_URL');
    expect(config).not.toContain('RELAYER_PRIVATE_KEY');
    expect(config).toContain('main = "/repository/packages/workers-server/src/index.ts"');
  });
});
