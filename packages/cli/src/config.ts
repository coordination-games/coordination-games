import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const COORD_DIR = path.join(os.homedir(), '.coordination');
const CONFIG_PATH = path.join(COORD_DIR, 'config.json');

export const DEFAULT_SERVER_URL = 'https://api.games.coop';

export interface Config {
  serverUrl: string;
  keyMode: 'local' | 'waap';
}

/** Session state persisted between CLI invocations */
export interface SessionState {
  /** Auth token from MCP signin */
  token?: string;
  /** Server-assigned agent ID */
  agentId?: string;
  /** MCP session ID for reusing transport sessions */
  mcpSessionId?: string;
  /** Current game ID (tracked after joining a lobby that starts a game) */
  currentGameId?: string;
  /** Current lobby ID */
  currentLobbyId?: string;
  /** Display name used for signin */
  handle?: string;
}

const SESSION_PATH = path.join(COORD_DIR, 'session.json');

export function loadConfig(): Config {
  if (!fs.existsSync(CONFIG_PATH)) {
    return { serverUrl: DEFAULT_SERVER_URL, keyMode: 'local' };
  }
  try {
    const data = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    return {
      serverUrl: data.serverUrl || DEFAULT_SERVER_URL,
      keyMode: data.keyMode || 'local',
    };
  } catch {
    return { serverUrl: DEFAULT_SERVER_URL, keyMode: 'local' };
  }
}

export function saveConfig(config: Config): void {
  if (!fs.existsSync(COORD_DIR)) {
    fs.mkdirSync(COORD_DIR, { mode: 0o700 });
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

export function loadSession(): SessionState {
  if (!fs.existsSync(SESSION_PATH)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(SESSION_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

export function saveSession(session: SessionState): void {
  if (!fs.existsSync(COORD_DIR)) {
    fs.mkdirSync(COORD_DIR, { mode: 0o700 });
  }
  fs.writeFileSync(SESSION_PATH, JSON.stringify(session, null, 2));
}
