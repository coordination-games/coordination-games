import { promises as fs } from 'node:fs';
import path from 'node:path';
import { redactText } from './gui/redact.js';

export class SeriesAnalysisInputError extends Error {
  readonly name = 'SeriesAnalysisInputError';
}

export type AnalysisInputs = {
  readonly manifest: unknown;
  readonly relayLines: readonly unknown[];
  readonly botTranscripts: Readonly<Record<string, readonly unknown[]>>;
  readonly availableGames: readonly {
    readonly gameId: string;
    readonly gameIndex: number;
    readonly status: 'completed' | 'incomplete';
  }[];
};

type AvailableGame = AnalysisInputs['availableGames'][number];

const RAW_PRIVATE_KEY = /(?:0x[0-9a-f]{64}|\b[0-9a-f]{64}\b)/i;

export async function loadAnalysisInputs(runDir: string): Promise<AnalysisInputs> {
  const seriesManifestPath = path.join(runDir, 'series-manifest.json');
  try {
    await fs.access(seriesManifestPath);
  } catch (error) {
    if (isMissing(error)) return loadLegacyInputs(runDir);
    throw new SeriesAnalysisInputError(`Could not access series-manifest.json: ${message(error)}`);
  }
  return loadSeriesInputs(runDir, await readJson(seriesManifestPath));
}

async function loadSeriesInputs(runDir: string, manifest: unknown): Promise<AnalysisInputs> {
  assertSafe(manifest, 'series-manifest.json');
  const source = record(manifest);
  const availableGames = parseAvailableGames(source);
  if (availableGames === undefined) {
    throw new SeriesAnalysisInputError('series-manifest.json omitted a valid gameIds array');
  }
  const relayLines: unknown[] = [];
  const botTranscripts: Record<string, readonly unknown[]> = {};
  for (const game of availableGames) {
    if (game.status === 'incomplete') continue;
    const { gameId, gameIndex } = game;
    const gameDir = path.join(runDir, 'games', String(gameIndex));
    const child = await readJson(path.join(gameDir, 'manifest.json'));
    assertSafe(child, `games/${gameIndex}/manifest.json`);
    if (record(child)?.gameId !== gameId) {
      throw new SeriesAnalysisInputError(
        `games/${gameIndex}/manifest.json does not match ${gameId}`,
      );
    }
    const gameRelay = [...(await readJsonl(path.join(gameDir, 'relay.jsonl')))].sort(relayIndex);
    for (const entry of gameRelay) assertRelay(entry, gameId, gameIndex);
    relayLines.push(...gameRelay);
    const botsDir = path.join(gameDir, 'bots');
    for (const fileName of (await directoryEntries(botsDir)).filter(isJsonl).sort()) {
      const events = (await readJsonl(path.join(botsDir, fileName))).filter(isNonRelayEvent);
      for (const entry of events) assertSafe(entry, `games/${gameIndex}/bots/${fileName}`);
      const botName = fileName.slice(0, -6);
      botTranscripts[botName] = [...(botTranscripts[botName] ?? []), ...events];
    }
  }
  return { manifest, relayLines, botTranscripts, availableGames };
}

async function loadLegacyInputs(runDir: string): Promise<AnalysisInputs> {
  const manifest = await readJson(path.join(runDir, 'manifest.json'));
  return {
    manifest,
    relayLines: await readJsonl(path.join(runDir, 'relay.jsonl')),
    botTranscripts: await readBots(path.join(runDir, 'bots')),
    availableGames: [],
  };
}

function parseAvailableGames(
  source: Readonly<Record<string, unknown>> | undefined,
): AnalysisInputs['availableGames'] | undefined {
  const descriptors = source?.availableGames;
  if (Array.isArray(descriptors)) {
    const parsed: AvailableGame[] = [];
    for (const descriptor of descriptors) {
      const game = record(descriptor);
      if (
        typeof game?.gameId !== 'string' ||
        typeof game.gameIndex !== 'number' ||
        (game.status !== 'completed' && game.status !== 'incomplete')
      )
        return undefined;
      parsed.push({
        gameId: game.gameId,
        gameIndex: game.gameIndex,
        status: game.status === 'completed' ? 'completed' : 'incomplete',
      });
    }
    return parsed.length === descriptors.length
      ? parsed.sort((left, right) => left.gameIndex - right.gameIndex)
      : undefined;
  }
  const gameIds = source?.gameIds;
  return Array.isArray(gameIds) && gameIds.every((gameId) => typeof gameId === 'string')
    ? gameIds.map((gameId, gameIndex) => ({ gameId, gameIndex, status: 'completed' as const }))
    : undefined;
}

function relayIndex(left: unknown, right: unknown): number {
  return number(left, 'index') - number(right, 'index');
}

function number(value: unknown, key: string): number {
  const candidate = record(value)?.[key];
  return typeof candidate === 'number' ? candidate : Number.MAX_SAFE_INTEGER;
}

function isNonRelayEvent(value: unknown): boolean {
  return record(value)?.kind !== 'relay';
}

async function readBots(botsDir: string): Promise<Readonly<Record<string, readonly unknown[]>>> {
  const files = await directoryEntries(botsDir);
  const entries = await Promise.all(
    files
      .filter(isJsonl)
      .map(
        async (fileName) =>
          [fileName.slice(0, -6), await readJsonl(path.join(botsDir, fileName))] as const,
      ),
  );
  return Object.fromEntries(entries);
}

function assertRelay(value: unknown, gameId: string, gameIndex: number): void {
  assertSafe(value, `games/${gameIndex}/relay.jsonl`);
  const relay = record(value);
  if (relay?.gameId !== gameId || typeof relay.index !== 'number' || !isSafeScope(relay.scope)) {
    throw new SeriesAnalysisInputError(
      `games/${gameIndex}/relay.jsonl has malformed relay provenance`,
    );
  }
}

function assertSafe(value: unknown, source: string): void {
  if (typeof value === 'string' && (redactText(value) !== value || RAW_PRIVATE_KEY.test(value))) {
    throw new SeriesAnalysisInputError(`${source} contains raw credential text`);
  }
  if (Array.isArray(value)) {
    for (const entry of value) assertSafe(entry, source);
    return;
  }
  const entry = record(value);
  if (!entry) return;
  for (const [key, child] of Object.entries(entry)) {
    if (isUnsafeKey(key))
      throw new SeriesAnalysisInputError(`${source} contains unsafe field ${key}`);
    assertSafe(child, source);
  }
}

function isUnsafeKey(key: string): boolean {
  return /^(?:hiddenreasoning|horizonsecret|privatekeys?|apikeys?|auth|authorization|credentials?|secrets?|tokens?|passwords?|rawtool(?:internals?)?)$/i.test(
    key.replace(/[^a-z0-9]/gi, ''),
  );
}

function isSafeScope(value: unknown): boolean {
  const scope = record(value);
  return (
    scope?.kind === 'all' || (scope?.kind === 'dm' && typeof scope.recipientHandle === 'string')
  );
}

async function readJson(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    throw new SeriesAnalysisInputError(
      `${path.basename(filePath)} is missing or malformed: ${message(error)}`,
    );
  }
}

async function readJsonl(filePath: string): Promise<readonly unknown[]> {
  try {
    return (await fs.readFile(filePath, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    throw new SeriesAnalysisInputError(
      `${path.basename(filePath)} is missing or malformed: ${message(error)}`,
    );
  }
}

async function directoryEntries(directory: string): Promise<readonly string[]> {
  try {
    return await fs.readdir(directory);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

function isJsonl(fileName: string): boolean {
  return fileName.endsWith('.jsonl');
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return Object.fromEntries(Object.entries(value));
}

function isMissing(error: unknown): boolean {
  return record(error)?.code === 'ENOENT';
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
