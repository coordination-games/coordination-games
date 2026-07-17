import { describe, expect, it } from 'vitest';
import {
  BootstrapInputError,
  buildWranglerCommands,
  parseBootstrapOptions,
} from './local-bootstrap.js';

const repositoryRoot = '/repo';
const persistenceDirectory = '/private/tmp/worker-state';

describe('local bootstrap command construction', () => {
  it('Given a caller-selected isolated directory, when parsing options, then builds local migration and dev commands for the same directory', () => {
    const options = parseBootstrapOptions(
      ['--persist-to', persistenceDirectory, '--port', '8799'],
      repositoryRoot,
    );

    expect(options).toEqual({ persistTo: persistenceDirectory, port: 8799 });
    expect(buildWranglerCommands(options, '/repo/wrangler.toml')).toEqual({
      migrate: [
        'd1',
        'migrations',
        'apply',
        'DB',
        '--local',
        '--persist-to',
        persistenceDirectory,
        '--config',
        '/repo/wrangler.toml',
      ],
      dev: [
        'dev',
        '--local',
        '--persist-to',
        persistenceDirectory,
        '--ip',
        '127.0.0.1',
        '--port',
        '8799',
        '--config',
        '/repo/wrangler.toml',
        '--show-interactive-dev-session',
        'false',
      ],
    });
  });

  it('Given no persistence directory, when parsing options, then rejects before a command can be spawned', () => {
    expect(() => parseBootstrapOptions([], repositoryRoot)).toThrow(BootstrapInputError);
  });

  it('Given a remote flag, when parsing options, then rejects before a command can be spawned', () => {
    expect(() =>
      parseBootstrapOptions(['--persist-to', persistenceDirectory, '--remote'], repositoryRoot),
    ).toThrow(BootstrapInputError);
  });

  it('Given the repository tracked Wrangler state, when parsing options, then rejects it as unsafe', () => {
    expect(() =>
      parseBootstrapOptions(['--persist-to', '/repo/.wrangler'], repositoryRoot),
    ).toThrow(BootstrapInputError);
  });

  it('Given a non-loopback port, when parsing options, then rejects it before a command can be spawned', () => {
    expect(() =>
      parseBootstrapOptions(
        ['--persist-to', persistenceDirectory, '--port', '70000'],
        repositoryRoot,
      ),
    ).toThrow(BootstrapInputError);
  });
});
