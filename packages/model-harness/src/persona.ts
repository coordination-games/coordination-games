import { promises as fs, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE_PROTOCOL_PROMPT } from './prompts.js';
import type { LoadedPersona } from './types.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundledPersonasDir = path.join(packageRoot, 'personas');

export function resolvePersonaDir(reference: string): string {
  if (path.isAbsolute(reference)) return reference;
  if (reference.startsWith('./') || reference.startsWith('../')) {
    const packagePath = path.resolve(packageRoot, reference);
    return isDirectory(packagePath) ? packagePath : path.resolve(reference);
  }
  const bundledPath = path.join(bundledPersonasDir, reference);
  return isDirectory(bundledPath) ? bundledPath : path.resolve(reference);
}

export async function loadPersona(reference: string): Promise<LoadedPersona> {
  const directory = resolvePersonaDir(reference);
  let persona: string;
  try {
    persona = await fs.readFile(path.join(directory, 'persona.md'), 'utf8');
  } catch {
    throw new Error(`loadPersona: persona.md not found in ${directory}`);
  }
  const context = await loadContext(directory);
  return { dir: directory, systemPromptFragment: persona + context };
}

export function assemblePrompt(botName: string, persona: LoadedPersona): string {
  return `${BASE_PROTOCOL_PROMPT(botName)}\n\n## Your persona\n${persona.systemPromptFragment}`;
}

function isDirectory(filePath: string): boolean {
  try {
    return statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

async function loadContext(directory: string): Promise<string> {
  try {
    const contextDirectory = path.join(directory, 'context');
    const files = (await fs.readdir(contextDirectory))
      .filter((file) => file.endsWith('.md'))
      .sort();
    const parts = await Promise.all(
      files.map((file) => fs.readFile(path.join(contextDirectory, file), 'utf8')),
    );
    return parts.length > 0 ? `\n\n${parts.join('\n\n')}` : '';
  } catch {
    return '';
  }
}
