/**
 * Transcript writer and analysis helpers for the Unified Model Harness.
 *
 * Provides:
 *  - makeRunDir(outputBase, runId)  — create output/<runId>/ with bots/ subdir
 *  - TranscriptWriter               — append-only JSONL sink per bot
 *  - writeRelayLog(runDir, msgs)    — persist relay.jsonl ground truth
 *  - writeManifest(runDir, manifest) — persist manifest.json
 *  - consequentialCounts(events)    — derive consequential vs talk-only counts
 *                                     from stateVersion changes on tool_result events
 *
 * Blueprint references: §8, §9.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { TranscriptEvent } from './types.js';

// ---------------------------------------------------------------------------
// Run directory layout
// ---------------------------------------------------------------------------

/**
 * Create the run directory structure:
 *   outputBase/<runId>/
 *   outputBase/<runId>/bots/
 *
 * runId must be supplied by the caller (typically from Date.now() at the
 * moment the orchestrator starts, as a string). This function never calls
 * Date.now() itself.
 *
 * Returns the absolute path to the run directory.
 */
export async function makeRunDir(outputBase: string, runId: string): Promise<string> {
  const runDir = path.resolve(outputBase, runId);
  await fs.mkdir(path.join(runDir, 'bots'), { recursive: true });
  return runDir;
}

// ---------------------------------------------------------------------------
// TranscriptWriter — append-only JSON-line per-bot sink
// ---------------------------------------------------------------------------

/**
 * A TranscriptWriter appends TranscriptEvents as JSON lines to per-bot files
 * inside <runDir>/bots/<botName>.jsonl. Each file is opened lazily on the
 * first event for that bot and kept open for the lifetime of the run.
 *
 * Usage:
 *   const writer = new TranscriptWriter(runDir);
 *   writer.onEvent(event);            // called by any AgentRunner
 *   await writer.close();             // flush and close all file handles
 */
export class TranscriptWriter {
  private readonly runDir: string;
  // Map from botName → open file handle (append mode)
  private readonly handles = new Map<string, fs.FileHandle>();

  constructor(runDir: string) {
    this.runDir = runDir;
  }

  /**
   * Append a single TranscriptEvent to bots/<event.bot>.jsonl.
   * Returns a Promise that resolves when the line is flushed.
   *
   * Safe to call concurrently — each bot has its own handle.
   */
  async onEvent(event: TranscriptEvent): Promise<void> {
    const handle = await this.handleFor(event.bot);
    const line = `${JSON.stringify(event)}\n`;
    await handle.write(line);
  }

  /**
   * Close all open file handles. Call once the run is complete.
   */
  async close(): Promise<void> {
    await Promise.all([...this.handles.values()].map((h) => h.close()));
    this.handles.clear();
  }

  private async handleFor(botName: string): Promise<fs.FileHandle> {
    const existing = this.handles.get(botName);
    if (existing) return existing;
    const filePath = path.join(this.runDir, 'bots', `${botName}.jsonl`);
    const handle = await fs.open(filePath, 'a');
    this.handles.set(botName, handle);
    return handle;
  }
}

// ---------------------------------------------------------------------------
// writeRelayLog
// ---------------------------------------------------------------------------

/**
 * Write the relay ground-truth log to <runDir>/relay.jsonl.
 *
 * relayMessages is an array of relay message objects (engine-shaped; the
 * harness treats them as opaque). Each element is written as a JSON line.
 */
export async function writeRelayLog(runDir: string, relayMessages: unknown[]): Promise<void> {
  const lines = relayMessages.map((m) => JSON.stringify(m)).join('\n');
  await fs.writeFile(path.join(runDir, 'relay.jsonl'), lines ? `${lines}\n` : '', 'utf8');
}

// ---------------------------------------------------------------------------
// writeManifest
// ---------------------------------------------------------------------------

/**
 * Write manifest.json to <runDir>/manifest.json.
 *
 * manifest is the full RunManifest object (see blueprint §8). Caller is
 * responsible for the shape; this function just serialises it.
 */
export async function writeManifest(runDir: string, manifest: unknown): Promise<void> {
  await fs.writeFile(
    path.join(runDir, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
}

// ---------------------------------------------------------------------------
// consequentialCounts — blueprint §9
// ---------------------------------------------------------------------------

/**
 * Universal, game-agnostic platform tools that NEVER mutate canonical state:
 *   - guide/state/wait : read-only (rules, fog-filtered state, long-poll)
 *   - chat             : the basic-chat plugin — relay only, never decides
 * Every OTHER named tool is a game/plugin action that mutates canonical state.
 */
const READ_ONLY_TOOLS = new Set(['guide', 'state', 'wait']);
const TALK_TOOLS = new Set(['chat']);

/** Strip the MCP prefix: `mcp__coga__extract_tile` → `extract_tile`. */
function baseToolName(name: string): string {
  const parts = name.split('__');
  return parts[parts.length - 1] ?? name;
}

/**
 * Derives consequential vs talk-only turn counts from a bot's transcript.
 *
 * Design note: §9 originally wanted to read this off the canonical state
 * version (knownStateVersion) advancing across a tool result. That signal is
 * NOT available here — the agent envelope deliberately strips meta.sinceIdx and
 * the state ETag before the bot sees it (see wiki/architecture/relay-and-cursor
 * and agent-envelope), so the bot's tool results never carry a state version
 * (which is why this read 0/0). Instead we classify by tool *semantics*, which
 * is equivalent and game-agnostic at the platform level: the universal
 * read/comms tools (guide/state/wait/chat) don't touch canonical state, and any
 * other named tool IS a state-mutating game action.
 *
 *   - guide/state/wait : skipped (not a turn — pure observation)
 *   - chat             : talk-only turn
 *   - anything else     : consequential turn (mutates canonical state)
 *
 * We read tool_CALL events, not tool_result: in the Claude stream a tool_result
 * block references only its tool_use_id (its `name` is "[toolu_…]"), so the tool
 * identity lives on the call. Only canonical `mcp__…` calls count; bare or
 * hallucinated names (e.g. "coga", "state" without the prefix) are malformed
 * calls the dispatcher rejects — they mutate nothing, so we skip them.
 */
export function consequentialCounts(events: TranscriptEvent[]): {
  consequentialTurns: number;
  talkOnlyTurns: number;
} {
  let consequentialTurns = 0;
  let talkOnlyTurns = 0;

  for (const ev of events) {
    if (ev.kind !== 'tool_call') continue;
    if (!ev.name.startsWith('mcp__')) continue; // hallucinated/malformed — skip
    const base = baseToolName(ev.name);
    if (READ_ONLY_TOOLS.has(base)) continue; // observation, not a turn
    if (TALK_TOOLS.has(base)) {
      talkOnlyTurns++;
      continue;
    }
    consequentialTurns++; // game/plugin action → mutates canonical state
  }

  return { consequentialTurns, talkOnlyTurns };
}
