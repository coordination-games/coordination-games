import { execFileSync } from 'node:child_process';

const ORGANIZATION_REPOSITORY = 'coordination-games/coordination-games';

function gitValue(repository: string, args: readonly string[]): string | undefined {
  try {
    const value = execFileSync('git', ['-C', repository, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .toString('utf8')
      .trim();
    return value.length === 0 ? undefined : value;
  } catch {
    return undefined;
  }
}

export function normalizeGitHubRepository(value: string): string | undefined {
  const trimmed = value.trim();
  const scpStyle = /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(trimmed);
  if (scpStyle !== null) {
    const [, owner, repository] = scpStyle;
    if (owner !== undefined && repository !== undefined) {
      return `${owner}/${repository}`.toLowerCase();
    }
  }

  const url = /^(?:https?|ssh):\/\/(?:[^@/]+@)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(
    trimmed,
  );
  if (url === null) {
    return undefined;
  }
  const [, owner, repository] = url;
  if (owner === undefined || repository === undefined) {
    return undefined;
  }
  return `${owner}/${repository}`.toLowerCase();
}

function currentBranch(repository: string): string | undefined {
  return gitValue(repository, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
}

function branchConfig(repository: string, branch: string, key: string): string | undefined {
  return gitValue(repository, ['config', '--get', `branch.${branch}.${key}`]);
}

function selectedPushRemote(repository: string): string | undefined {
  const branch = currentBranch(repository);
  if (branch === undefined) {
    return undefined;
  }
  const pushRemote = branchConfig(repository, branch, 'pushRemote');
  if (pushRemote !== undefined) {
    return pushRemote;
  }
  const pushDefault = gitValue(repository, ['config', '--get', 'remote.pushDefault']);
  if (pushDefault !== undefined) {
    return pushDefault;
  }
  return branchConfig(repository, branch, 'remote');
}

function selectedPushUrls(repository: string, remote: string): readonly string[] {
  const urls = gitValue(repository, ['remote', 'get-url', '--all', '--push', remote]);
  return urls === undefined ? [] : urls.split('\n');
}

export function organizationRemoteFailure(repository: string): string | undefined {
  const remote = selectedPushRemote(repository);
  if (remote === undefined) {
    return (
      'Org-bound validation requires a checked-out branch with a push route. ' +
      'Configure branch.<name>.pushRemote, remote.pushDefault, or branch.<name>.remote.'
    );
  }
  const urls = selectedPushUrls(repository, remote);
  if (urls.length === 0) {
    return (
      `The selected push remote ${JSON.stringify(remote)} has no readable push URL. ` +
      'Configure that remote, then retry.'
    );
  }
  if (urls.some((url) => normalizeGitHubRepository(url) === ORGANIZATION_REPOSITORY)) {
    return undefined;
  }
  return (
    `The selected push remote ${JSON.stringify(remote)} does not target ${ORGANIZATION_REPOSITORY}. ` +
    'Point the selected route at the organization remote, then retry.'
  );
}
