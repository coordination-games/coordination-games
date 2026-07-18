import { promises as fs } from 'node:fs';
import path from 'node:path';

export class SeriesArtifactError extends Error {
  readonly name = 'SeriesArtifactError';
}

export type SeriesArtifactIo = {
  readonly write: (targetPath: string, value: unknown) => Promise<void>;
  readonly appendJsonLine: (targetPath: string, value: unknown) => Promise<void>;
};

export function createSeriesArtifactIo(input: {
  readonly beforeRename?: (targetPath: string) => void;
}): SeriesArtifactIo {
  const write = (targetPath: string, value: unknown) =>
    writeAtomic({
      targetPath,
      value,
      ...(input.beforeRename ? { beforeRename: input.beforeRename } : {}),
    });
  let appendQueue = Promise.resolve();
  return {
    write,
    appendJsonLine(targetPath, value) {
      const append = appendQueue.then(async () => {
        const existing = await readText(targetPath);
        await write(targetPath, `${existing}${JSON.stringify(value)}\n`);
      });
      appendQueue = append.catch(() => undefined);
      return append;
    },
  };
}

async function writeAtomic(input: {
  readonly targetPath: string;
  readonly value: unknown;
  readonly beforeRename?: (targetPath: string) => void;
}): Promise<void> {
  const text =
    typeof input.value === 'string' ? input.value : `${JSON.stringify(input.value, null, 2)}\n`;
  const temporaryPath = `${input.targetPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.mkdir(path.dirname(input.targetPath), { recursive: true });
    await fs.writeFile(temporaryPath, text, 'utf8');
    input.beforeRename?.(input.targetPath);
    await fs.rename(temporaryPath, input.targetPath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true });
    throw new SeriesArtifactError(
      `Could not atomically write ${path.basename(input.targetPath)}: ${message(error)}`,
    );
  }
}

async function readText(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (record(error)?.code === 'ENOENT') return '';
    throw error;
  }
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return Object.fromEntries(Object.entries(value));
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
