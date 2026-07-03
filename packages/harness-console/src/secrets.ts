/**
 * Local secrets: OpenRouter API key + inspector (admin) token.
 *
 * Stored at ~/.coordination/console-secrets.json, file mode 0600. Values are
 * NEVER returned by the API (status is presence-only) and enter a run solely
 * as child-process env (OPENROUTER_API_KEY / INSPECTOR_TOKEN).
 */

import { promises as fsp } from 'node:fs';
import { SECRETS_DIR, SECRETS_FILE } from './paths.js';

export type SecretName = 'openrouter' | 'inspector' | 'claude';

interface SecretsFile {
  openrouter?: string;
  inspector?: string;
  /** `claude setup-token` output — lets claude-backed seats run without an
   * interactive ~/.claude login (passed as CLAUDE_CODE_OAUTH_TOKEN). */
  claude?: string;
}

const SECRET_NAMES: SecretName[] = ['openrouter', 'inspector', 'claude'];

export function isSecretName(v: string): v is SecretName {
  return (SECRET_NAMES as string[]).includes(v);
}

async function readFileSafe(): Promise<SecretsFile> {
  try {
    const raw = await fsp.readFile(SECRETS_FILE, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed as SecretsFile;
  } catch {
    // Missing or unreadable — treat as empty.
  }
  return {};
}

async function writeFileSafe(secrets: SecretsFile): Promise<void> {
  await fsp.mkdir(SECRETS_DIR, { recursive: true, mode: 0o700 });
  await fsp.writeFile(SECRETS_FILE, `${JSON.stringify(secrets, null, 2)}\n`, { mode: 0o600 });
  await fsp.chmod(SECRETS_FILE, 0o600);
}

/** Presence-only view, safe to return to the browser. */
export async function secretStatus(): Promise<Record<SecretName, boolean>> {
  const s = await readFileSafe();
  return {
    openrouter: Boolean(s.openrouter),
    inspector: Boolean(s.inspector),
    claude: Boolean(s.claude),
  };
}

export async function setSecret(name: SecretName, value: string): Promise<void> {
  const s = await readFileSafe();
  s[name] = value;
  await writeFileSafe(s);
}

export async function deleteSecret(name: SecretName): Promise<void> {
  const s = await readFileSafe();
  delete s[name];
  await writeFileSafe(s);
}

/**
 * Env additions for a spawned harness/analyze child. The inspector token falls
 * back to the local dev default (matches workers-server .dev.vars ADMIN_TOKEN).
 */
export async function childEnv(): Promise<Record<string, string>> {
  const s = await readFileSafe();
  const env: Record<string, string> = {
    INSPECTOR_TOKEN: s.inspector ?? process.env.INSPECTOR_TOKEN ?? 'local-inspector-token',
  };
  const openrouter = s.openrouter ?? process.env.OPENROUTER_API_KEY;
  if (openrouter) env.OPENROUTER_API_KEY = openrouter;
  // Saved setup-token wins over ambient login so runs are reproducible for
  // whoever configured the console; absent both, `claude` uses ~/.claude.
  const claude = s.claude ?? process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (claude) env.CLAUDE_CODE_OAUTH_TOKEN = claude;
  return env;
}
