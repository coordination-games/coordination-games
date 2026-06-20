/**
 * Persona loader for the Unified Model Harness.
 *
 * loadPersona(dir) → LoadedPersona: reads a persona bundle directory:
 *   - persona.md      REQUIRED. The persona's system-prompt fragment.
 *   - context/*.md    OPTIONAL. Extra reference material concatenated after persona.md.
 *   - persona.yaml    OPTIONAL. Metadata (defaultModel, extraMcpServers).
 *
 * assemblePrompt(base, persona) → string: layers persona on top of the base
 * protocol prompt using the §5 assembly contract.
 *
 * Reference: docs/plans/unified-model-harness.md §5.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { ExtraMcpServer, LoadedPersona } from './types.js';

// ---------------------------------------------------------------------------
// loadPersona
// ---------------------------------------------------------------------------

/**
 * Load a persona bundle from a directory.
 *
 * @param dir - Absolute or relative path to the persona bundle directory.
 * @returns Fully loaded persona ready for prompt assembly.
 * @throws If persona.md is missing or unreadable.
 */
export async function loadPersona(dir: string): Promise<LoadedPersona> {
  const absDir = path.resolve(dir);

  // --- Required: persona.md ---
  const personaMdPath = path.join(absDir, 'persona.md');
  let personaMd: string;
  try {
    personaMd = await fs.readFile(personaMdPath, 'utf8');
  } catch (err) {
    throw new Error(
      `loadPersona: persona.md not found or unreadable at ${personaMdPath}: ${String(err)}`,
    );
  }

  // --- Optional: context/*.md — sort for determinism ---
  let contextFragment = '';
  const contextDir = path.join(absDir, 'context');
  try {
    const entries = await fs.readdir(contextDir);
    const mdFiles = entries.filter((e) => e.endsWith('.md')).sort();
    const parts: string[] = [];
    for (const file of mdFiles) {
      const content = await fs.readFile(path.join(contextDir, file), 'utf8');
      parts.push(content.trim());
    }
    if (parts.length > 0) {
      contextFragment = `\n\n${parts.join('\n\n')}`;
    }
  } catch (err) {
    // ENOENT → no context dir, fine.
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      throw new Error(`loadPersona: error reading context/ in ${absDir}: ${String(err)}`);
    }
  }

  // Combine persona.md + context fragments into the system-prompt fragment.
  const systemPromptFragment = personaMd.trim() + contextFragment;

  // --- Optional: persona.yaml ---
  let defaultModel: string | undefined;
  let extraMcpServers: ExtraMcpServer[] | undefined;

  const personaYamlPath = path.join(absDir, 'persona.yaml');
  try {
    const yamlRaw = await fs.readFile(personaYamlPath, 'utf8');
    const meta: unknown = parseYaml(yamlRaw);
    if (typeof meta === 'object' && meta !== null && !Array.isArray(meta)) {
      const m = meta as Record<string, unknown>;
      if (typeof m.defaultModel === 'string' && m.defaultModel.trim()) {
        defaultModel = m.defaultModel.trim();
      }
      if (Array.isArray(m.extraMcpServers)) {
        extraMcpServers = parseExtraMcpServers(m.extraMcpServers, personaYamlPath);
      }
    }
  } catch (err) {
    // ENOENT → no persona.yaml, apply defaults.
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      throw new Error(`loadPersona: error reading persona.yaml in ${absDir}: ${String(err)}`);
    }
  }

  const result: LoadedPersona = {
    dir: absDir,
    systemPromptFragment,
    ...(defaultModel !== undefined ? { defaultModel } : {}),
    ...(extraMcpServers !== undefined ? { extraMcpServers } : {}),
  };

  return result;
}

// ---------------------------------------------------------------------------
// assemblePrompt
// ---------------------------------------------------------------------------

/**
 * Assemble the full system prompt for a bot session.
 *
 * Contract (§5):
 *   systemPrompt = base + "\n\n## Your persona\n" + persona.systemPromptFragment
 *
 * @param base    - BASE_PROTOCOL_PROMPT(botName) — the game-agnostic protocol prompt.
 * @param persona - The loaded persona bundle.
 * @returns The complete system prompt ready for the agent runner.
 */
export function assemblePrompt(base: string, persona: LoadedPersona): string {
  return `${base}\n\n## Your persona\n${persona.systemPromptFragment}`;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function parseExtraMcpServers(raw: unknown[], filePath: string): ExtraMcpServer[] {
  return raw.map((entry: unknown, idx: number) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`loadPersona: extraMcpServers[${idx}] must be an object in ${filePath}`);
    }
    const s = entry as Record<string, unknown>;
    if (typeof s.name !== 'string' || !(s.name as string).trim()) {
      throw new Error(`loadPersona: extraMcpServers[${idx}].name is required in ${filePath}`);
    }
    if (typeof s.command !== 'string' || !(s.command as string).trim()) {
      throw new Error(`loadPersona: extraMcpServers[${idx}].command is required in ${filePath}`);
    }
    const args: string[] | undefined =
      Array.isArray(s.args) && s.args.every((a) => typeof a === 'string')
        ? (s.args as string[])
        : undefined;

    return {
      name: (s.name as string).trim(),
      command: (s.command as string).trim(),
      ...(args !== undefined ? { args } : {}),
    } satisfies ExtraMcpServer;
  });
}
