import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { TranscriptEvent } from './types.js';

export interface TranscriptWriter {
  onEvent(event: TranscriptEvent): void;
  flush(): Promise<void>;
  eventsFor(botName: string): readonly TranscriptEvent[];
}

export function makeTranscriptWriter(runDir: string): TranscriptWriter {
  const events = new Map<string, TranscriptEvent[]>();
  const handles = new Map<string, fs.FileHandle>();
  const pendingWrites = new Set<Promise<void>>();
  const handleFor = async (botName: string): Promise<fs.FileHandle> => {
    const existing = handles.get(botName);
    if (existing) return existing;
    await fs.mkdir(path.join(runDir, 'bots'), { recursive: true });
    const handle = await fs.open(path.join(runDir, 'bots', `${botName}.jsonl`), 'a');
    handles.set(botName, handle);
    return handle;
  };
  return {
    onEvent(event) {
      const botEvents = events.get(event.bot) ?? [];
      botEvents.push(event);
      events.set(event.bot, botEvents);
      let write: Promise<void>;
      write = handleFor(event.bot)
        .then((handle) => handle.write(`${JSON.stringify(event)}\n`))
        .catch((error) =>
          console.error(`[transcript] write error for ${event.bot}: ${String(error)}`),
        )
        .then(() => {
          pendingWrites.delete(write);
        });
      pendingWrites.add(write);
    },
    async flush() {
      await Promise.all(pendingWrites);
      await Promise.all([...handles.values()].map((handle) => handle.close()));
      handles.clear();
    },
    eventsFor(botName) {
      return events.get(botName) ?? [];
    },
  };
}
