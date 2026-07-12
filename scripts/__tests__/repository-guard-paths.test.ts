import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  isForbiddenPrivatePath,
  RepositoryGuardError,
  runRepositoryGuard,
} from '../repository-guard.js';
import { cleanupRepositories, createRepository, git } from './repository-guard-fixture.js';

afterEach(cleanupRepositories);

describe('repository private-path policy', () => {
  it('rejects private aliases while allowing public docs plans', () => {
    // Given private aliases and public documentation / When classified / Then only private aliases are forbidden
    expect(isForbiddenPrivatePath('.omo/evidence/receipt.txt')).toBe(true);
    expect(isForbiddenPrivatePath('SOT')).toBe(true);
    expect(isForbiddenPrivatePath('Coordination-Games-SOT/ROADMAP.md')).toBe(true);
    expect(isForbiddenPrivatePath('plans/private.md')).toBe(true);
    expect(isForbiddenPrivatePath('evidence/run.txt')).toBe(true);
    expect(isForbiddenPrivatePath('docs/plans/feature.md')).toBe(false);
  });
});

describe('repository staged and tracked paths', () => {
  it('rejects a forbidden staged path with spaces and newlines', async () => {
    // Given a newly staged private file / When staged mode runs / Then the commit boundary is rejected
    const repository = await createRepository();
    const privatePath = '.omo/evidence/receipt with space\nand newline.txt';
    await fs.mkdir(path.join(repository, '.omo/evidence'), { recursive: true });
    await fs.writeFile(path.join(repository, privatePath), 'private');
    git(repository, ['add', '--', privatePath]);

    expect(() => runRepositoryGuard({ repository, mode: 'staged' })).toThrow(RepositoryGuardError);
  });

  it('rejects forbidden copy, rename, and modification destinations in staged mode', async () => {
    // Given private paths from every non-deletion staged status / When guarded / Then each is rejected
    const copiedRepository = await createRepository();
    await fs.writeFile(path.join(copiedRepository, 'public.txt'), 'private text');
    git(copiedRepository, ['add', 'public.txt']);
    git(copiedRepository, ['commit', '--quiet', '-m', 'public fixture']);
    await fs.mkdir(path.join(copiedRepository, '.omo'), { recursive: true });
    await fs.copyFile(
      path.join(copiedRepository, 'public.txt'),
      path.join(copiedRepository, '.omo/copied.txt'),
    );
    git(copiedRepository, ['add', '.omo/copied.txt']);

    const renamedRepository = await createRepository();
    await fs.writeFile(path.join(renamedRepository, 'public.txt'), 'private text');
    git(renamedRepository, ['add', 'public.txt']);
    git(renamedRepository, ['commit', '--quiet', '-m', 'public fixture']);
    await fs.mkdir(path.join(renamedRepository, '.omo'), { recursive: true });
    await fs.rename(
      path.join(renamedRepository, 'public.txt'),
      path.join(renamedRepository, '.omo/renamed.txt'),
    );
    git(renamedRepository, ['add', '--all']);

    const modifiedRepository = await createRepository();
    await fs.mkdir(path.join(modifiedRepository, '.omo'), { recursive: true });
    await fs.writeFile(path.join(modifiedRepository, '.omo/modified.txt'), 'before');
    git(modifiedRepository, ['add', '.omo/modified.txt']);
    git(modifiedRepository, ['commit', '--quiet', '-m', 'bad historical path']);
    await fs.writeFile(path.join(modifiedRepository, '.omo/modified.txt'), 'after');
    git(modifiedRepository, ['add', '.omo/modified.txt']);

    expect(() => runRepositoryGuard({ repository: copiedRepository, mode: 'staged' })).toThrow(
      RepositoryGuardError,
    );
    expect(() => runRepositoryGuard({ repository: renamedRepository, mode: 'staged' })).toThrow(
      RepositoryGuardError,
    );
    expect(() => runRepositoryGuard({ repository: modifiedRepository, mode: 'staged' })).toThrow(
      RepositoryGuardError,
    );
  });

  it('rejects a forbidden tracked path in full-tree mode', async () => {
    // Given a tracked private SOT path / When full-tree mode runs / Then CI-style validation rejects it
    const repository = await createRepository();
    await fs.mkdir(path.join(repository, 'SOT'), { recursive: true });
    await fs.writeFile(path.join(repository, 'SOT/ROADMAP.md'), 'private');
    git(repository, ['add', 'SOT/ROADMAP.md']);

    expect(() => runRepositoryGuard({ repository, mode: 'full' })).toThrow(RepositoryGuardError);
  });

  it('allows deletion of an already-forbidden tracked path in staged mode', async () => {
    // Given a historical forbidden path staged for deletion / When staged mode runs / Then cleanup is permitted
    const repository = await createRepository();
    await fs.mkdir(path.join(repository, '.omo'), { recursive: true });
    await fs.writeFile(path.join(repository, '.omo/old-plan.md'), 'private');
    git(repository, ['add', '.omo/old-plan.md']);
    git(repository, ['commit', '--quiet', '-m', 'bad historical path']);
    await fs.rm(path.join(repository, '.omo/old-plan.md'));
    git(repository, ['add', '--all', '.omo/old-plan.md']);

    expect(() => runRepositoryGuard({ repository, mode: 'staged' })).not.toThrow();
  });
});
