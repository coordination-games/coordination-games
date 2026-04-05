import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
const COORD_DIR = path.join(os.homedir(), ".coordination");
const CONFIG_PATH = path.join(COORD_DIR, "config.json");
export const DEFAULT_SERVER_URL = "https://capturethelobster.com";
const SESSION_PATH = path.join(COORD_DIR, "session.json");
export function loadConfig() {
    if (!fs.existsSync(CONFIG_PATH)) {
        return { serverUrl: DEFAULT_SERVER_URL, keyMode: "local" };
    }
    try {
        const data = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
        return {
            serverUrl: data.serverUrl || DEFAULT_SERVER_URL,
            keyMode: data.keyMode || "local",
        };
    }
    catch {
        return { serverUrl: DEFAULT_SERVER_URL, keyMode: "local" };
    }
}
export function saveConfig(config) {
    if (!fs.existsSync(COORD_DIR)) {
        fs.mkdirSync(COORD_DIR, { mode: 0o700 });
    }
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}
export function loadSession() {
    if (!fs.existsSync(SESSION_PATH)) {
        return {};
    }
    try {
        return JSON.parse(fs.readFileSync(SESSION_PATH, "utf-8"));
    }
    catch {
        return {};
    }
}
export function saveSession(session) {
    if (!fs.existsSync(COORD_DIR)) {
        fs.mkdirSync(COORD_DIR, { mode: 0o700 });
    }
    fs.writeFileSync(SESSION_PATH, JSON.stringify(session, null, 2));
}
//# sourceMappingURL=config.js.map