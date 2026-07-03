/**
 * Console vocabulary: available games, persona bundles, model suggestions.
 * Games and personas are discovered from the repo at request time — no
 * hardcoded game list (mirrors the harness's game-agnostic stance).
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { BUNDLED_PERSONAS_DIR, CUSTOM_PERSONAS_DIR, GAMES_DIR, OUTPUT_DIR } from './paths.js';

export interface PersonaInfo {
  /** Spec-ready ref: bare name for bundled, absolute dir for custom. */
  ref: string;
  name: string;
  source: 'bundled' | 'custom';
  /** persona.md contents (what the seat's system prompt is built from). */
  text: string;
}

export interface ConsoleMeta {
  games: string[];
  personas: PersonaInfo[];
  modelSuggestions: { claude: string[]; openrouter: string[] };
  outputDir: string;
}

/** Model datalists (Djimo's console pattern). Claude = local creds / setup token, rest = OpenRouter. */
const MODEL_SUGGESTIONS = {
  claude: [
    'anthropic/claude-haiku',
    'anthropic/claude-sonnet-5',
    'anthropic/claude-sonnet',
    'anthropic/claude-opus',
  ],
  openrouter: [
    'openrouter/minimax/minimax-m2',
    'openrouter/anthropic/claude-haiku',
    'openai/gpt-4o',
    'openai/gpt-4o-mini',
    'google/gemini-2.5-flash',
    'deepseek/deepseek-chat',
  ],
};

async function listDirs(dir: string): Promise<string[]> {
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

async function loadPersonas(dir: string, source: 'bundled' | 'custom'): Promise<PersonaInfo[]> {
  const names = await listDirs(dir);
  const out: PersonaInfo[] = [];
  for (const name of names) {
    try {
      const text = await fsp.readFile(path.join(dir, name, 'persona.md'), 'utf8');
      out.push({ ref: source === 'bundled' ? name : path.join(dir, name), name, source, text });
    } catch {
      // Not a persona bundle — skip.
    }
  }
  return out;
}

export async function consoleMeta(): Promise<ConsoleMeta> {
  const [games, bundled, custom] = await Promise.all([
    listDirs(GAMES_DIR),
    loadPersonas(BUNDLED_PERSONAS_DIR, 'bundled'),
    loadPersonas(CUSTOM_PERSONAS_DIR, 'custom'),
  ]);
  return {
    games,
    personas: [...bundled, ...custom],
    modelSuggestions: MODEL_SUGGESTIONS,
    outputDir: OUTPUT_DIR,
  };
}

/** Write a custom persona bundle; returns the spec-ready absolute ref. */
export async function saveCustomPersona(name: string, text: string): Promise<string> {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) throw new Error('persona name must contain letters or digits');
  const dir = path.join(CUSTOM_PERSONAS_DIR, slug);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'persona.md'), text.endsWith('\n') ? text : `${text}\n`);
  return dir;
}
