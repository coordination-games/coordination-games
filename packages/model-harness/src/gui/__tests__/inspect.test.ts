import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inspectArtifact, previewArtifactFile } from '../inspect.js';
import type { BoundedRoot } from '../paths.js';

let rootDir: string;
const roots = (): BoundedRoot[] => [{ key: 't', label: 't/', dir: rootDir }];

const MANIFEST = {
  runId: 'run-42',
  lobbyId: 'lobby-abc',
  gameId: 'game-def',
  spec: { game: 'tragedy-of-the-commons', label: 'demo' },
  seats: [
    { bot: 'bot1', persona: '/x/personas/peaceful-mediator', model: 'haiku', backend: 'claude' },
    {
      bot: 'bot2',
      persona: '/x/personas/win-focused-builder',
      model: 'gpt',
      backend: 'openrouter',
    },
  ],
  outcome: { phase: 'finished', winnerLabel: 'bot2', round: 8 },
  apiKey: 'sk-live-secret-000000',
};

beforeAll(async () => {
  rootDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gui-artifacts-'));
  const run = path.join(rootDir, 'run-good');
  await fsp.mkdir(path.join(run, 'bots'), { recursive: true });
  await fsp.writeFile(path.join(run, 'manifest.json'), JSON.stringify(MANIFEST));
  await fsp.writeFile(
    path.join(run, 'analysis.json'),
    JSON.stringify({ betrayals: [1, 2], deceptions: [] }),
  );
  await fsp.writeFile(path.join(run, 'relay.jsonl'), '{"a":1}\n{"a":2}\n{"a":3}\n');
  await fsp.writeFile(path.join(run, 'bots', 'bot1.jsonl'), '{"k":"turn"}\n{"k":"turn"}\n');
  const bad = path.join(rootDir, 'run-bad');
  await fsp.mkdir(bad, { recursive: true });
  await fsp.writeFile(path.join(bad, 'manifest.json'), '{not json');
  const legacy = path.join(rootDir, 'run-legacy');
  await fsp.mkdir(legacy, { recursive: true });
  await fsp.writeFile(
    path.join(legacy, 'manifest.json'),
    JSON.stringify({
      runId: 'run-legacy',
      outcome: { phase: 'finished', winnerHandle: 'bot9', round: 3 },
    }),
  );
});

afterAll(async () => {
  await fsp.rm(rootDir, { recursive: true, force: true });
});

describe('inspectArtifact — audit extraction', () => {
  it('extracts identifiers, seats, outcome, and event counts from a run dir', async () => {
    // Given a complete run dir / When inspected / Then the audit carries provenance
    const audit = await inspectArtifact('t:run-good', roots());
    expect(audit.identifiers).toEqual({
      runId: 'run-42',
      lobbyId: 'lobby-abc',
      gameId: 'game-def',
      game: 'tragedy-of-the-commons',
      label: 'demo',
    });
    expect(audit.seats).toEqual([
      { bot: 'bot1', persona: 'peaceful-mediator', model: 'haiku', backend: 'claude' },
      { bot: 'bot2', persona: 'win-focused-builder', model: 'gpt', backend: 'openrouter' },
    ]);
    expect(audit.outcome).toEqual({ phase: 'finished', winnerLabel: 'bot2', round: 8 });
    expect(audit.relay).toEqual({ file: 'relay.jsonl', lines: 3, truncated: false });
    expect(audit.bots).toEqual([{ file: 'bots/bot1.jsonl', lines: 2, truncated: false }]);
    expect(audit.analysis).toEqual({ present: true, sections: { betrayals: 2, deceptions: 0 } });
    expect(audit.errors).toEqual([]);
  });

  it('falls back to legacy winnerHandle when winnerLabel is absent', async () => {
    // Given a pre-rename manifest / When inspected / Then the canonical field carries it
    const audit = await inspectArtifact('t:run-legacy', roots());
    expect(audit.outcome).toEqual({ phase: 'finished', winnerLabel: 'bot9', round: 3 });
  });

  it('records malformed JSON as a parse issue instead of throwing', async () => {
    // Given a corrupt manifest / When inspected / Then the error is surfaced as data
    const audit = await inspectArtifact('t:run-bad', roots());
    expect(audit.identifiers.runId).toBeNull();
    expect(audit.errors).toHaveLength(1);
    expect(audit.errors[0]?.file).toBe('manifest.json');
  });

  it('rejects traversal ids before touching the filesystem', async () => {
    await expect(inspectArtifact('t:../outside', roots())).rejects.toThrow(
      'path segments "", "." and ".." are not allowed',
    );
  });
});

describe('previewArtifactFile — whitelisted, redacted previews', () => {
  it('previews manifest.json with secrets redacted', async () => {
    // Given a manifest embedding a key / When previewed / Then the key is gone
    const preview = await previewArtifactFile('t:run-good', 'manifest.json', roots());
    expect(preview.text).toContain('run-42');
    expect(preview.text).not.toContain('sk-live-secret-000000');
    expect(preview.truncated).toBe(false);
  });

  it('rejects files outside the preview whitelist', async () => {
    await expect(
      previewArtifactFile('t:run-good', '../run-bad/manifest.json', roots()),
    ).rejects.toThrow('file is not previewable');
    await expect(previewArtifactFile('t:run-good', 'secrets.txt', roots())).rejects.toThrow(
      'file is not previewable',
    );
  });
});
