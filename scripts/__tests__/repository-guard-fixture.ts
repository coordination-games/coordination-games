import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temporaryRepositories: string[] = [];

export function git(repository: string, args: readonly string[]): void {
  execFileSync('git', ['-C', repository, ...args], { stdio: 'pipe' });
}

export async function createRepository(): Promise<string> {
  const repository = await fs.mkdtemp(path.join(os.tmpdir(), 'coordination-repo-guard-'));
  temporaryRepositories.push(repository);
  git(repository, ['init', '--quiet']);
  git(repository, ['config', 'user.email', 'guard@example.test']);
  git(repository, ['config', 'user.name', 'Repository Guard Test']);
  await fs.mkdir(path.join(repository, 'packages/engine'), { recursive: true });
  await fs.mkdir(path.join(repository, 'packages/games/capture-the-lobster'), { recursive: true });
  await fs.mkdir(path.join(repository, 'packages/workers-server'), { recursive: true });
  await fs.writeFile(path.join(repository, 'package.json'), '{"name":"capture-the-lobster"}\n');
  await fs.writeFile(path.join(repository, 'README.md'), '# Coordination Games\n');
  await fs.writeFile(path.join(repository, 'packages/engine/package.json'), '{}\n');
  await fs.writeFile(
    path.join(repository, 'packages/games/capture-the-lobster/package.json'),
    '{}\n',
  );
  await fs.writeFile(path.join(repository, 'packages/workers-server/package.json'), '{}\n');
  git(repository, ['add', '.']);
  git(repository, ['commit', '--quiet', '-m', 'fixture']);
  git(repository, ['branch', '-M', 'org-bound-feature']);
  return repository;
}

export async function cleanupRepositories(): Promise<void> {
  await Promise.all(
    temporaryRepositories
      .splice(0)
      .map((repository) => fs.rm(repository, { recursive: true, force: true })),
  );
}
