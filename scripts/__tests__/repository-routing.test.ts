import { afterEach, describe, expect, it } from 'vitest';
import {
  normalizeGitHubRepository,
  RepositoryGuardError,
  runRepositoryGuard,
} from '../repository-guard.js';
import { cleanupRepositories, createRepository, git } from './repository-guard-fixture.js';

afterEach(cleanupRepositories);

function addRemote(repository: string, name: string, url: string): void {
  git(repository, ['remote', 'add', name, url]);
}

const forkUrl = 'https://github.com/contributor/coordination-games.git';
const organizationUrl = 'https://github.com/coordination-games/coordination-games.git';

describe('repository organization routing', () => {
  it('normalizes HTTPS, SSH, and scp-style GitHub repository URLs', () => {
    // Given equivalent GitHub URLs / When normalized / Then the owner/repository identity is stable
    expect(normalizeGitHubRepository(organizationUrl)).toBe(
      'coordination-games/coordination-games',
    );
    expect(
      normalizeGitHubRepository('ssh://git@github.com/coordination-games/coordination-games/'),
    ).toBe('coordination-games/coordination-games');
    expect(
      normalizeGitHubRepository('git@github.com:coordination-games/coordination-games.git'),
    ).toBe('coordination-games/coordination-games');
  });

  it('rejects an org-bound branch with no effective push route even when an org remote exists', async () => {
    // Given fork and org remotes but no branch route / When org-bound validation runs / Then it fails closed
    const repository = await createRepository();
    addRemote(repository, 'fork', forkUrl);
    addRemote(repository, 'handoff', organizationUrl);

    expect(() =>
      runRepositoryGuard({ repository, mode: 'full', requireOrgDestination: true }),
    ).toThrow(RepositoryGuardError);
  });

  it('rejects a branch pushRemote that selects a fork despite a separate org remote', async () => {
    // Given a fork is the selected push remote / When org-bound validation runs / Then another org remote cannot bypass it
    const repository = await createRepository();
    addRemote(repository, 'fork', forkUrl);
    addRemote(repository, 'handoff', organizationUrl);
    git(repository, ['config', 'branch.org-bound-feature.pushRemote', 'fork']);

    expect(() =>
      runRepositoryGuard({ repository, mode: 'full', requireOrgDestination: true }),
    ).toThrow(RepositoryGuardError);
  });

  it('prefers remote.pushDefault over the branch upstream remote', async () => {
    // Given a fork push default and organization upstream / When org-bound validation runs / Then the fork route wins and fails
    const repository = await createRepository();
    addRemote(repository, 'fork', forkUrl);
    addRemote(repository, 'handoff', organizationUrl);
    git(repository, ['config', 'remote.pushDefault', 'fork']);
    git(repository, ['config', 'branch.org-bound-feature.remote', 'handoff']);

    expect(() =>
      runRepositoryGuard({ repository, mode: 'full', requireOrgDestination: true }),
    ).toThrow(RepositoryGuardError);
  });

  it('uses the branch upstream remote when earlier routing settings are absent', async () => {
    // Given only the branch upstream route is configured / When org-bound validation runs / Then its org target is accepted
    const repository = await createRepository();
    addRemote(repository, 'handoff', organizationUrl);
    git(repository, ['config', 'branch.org-bound-feature.remote', 'handoff']);

    expect(() =>
      runRepositoryGuard({ repository, mode: 'full', requireOrgDestination: true }),
    ).not.toThrow();
  });

  it('accepts a contributor fork plus an org-selected push remote', async () => {
    // Given arbitrary fork and organization remote names / When the branch selects the org route / Then it passes
    const repository = await createRepository();
    addRemote(repository, 'personal-fork', 'git@github.com:contributor/coordination-games.git');
    addRemote(
      repository,
      'handoff',
      'ssh://git@github.com/coordination-games/coordination-games.git',
    );
    git(repository, ['config', 'branch.org-bound-feature.pushRemote', 'handoff']);

    expect(() =>
      runRepositoryGuard({ repository, mode: 'full', requireOrgDestination: true }),
    ).not.toThrow();
  });

  it('rejects a detached org-bound checkout because it has no branch route', async () => {
    // Given a detached checkout with an available org remote / When org-bound validation runs / Then remediation is required
    const repository = await createRepository();
    addRemote(repository, 'handoff', organizationUrl);
    git(repository, ['checkout', '--quiet', '--detach']);

    expect(() =>
      runRepositoryGuard({ repository, mode: 'full', requireOrgDestination: true }),
    ).toThrow(RepositoryGuardError);
  });
});
