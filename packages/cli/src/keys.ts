import { ethers } from "ethers";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const COORD_DIR = path.join(os.homedir(), ".coordination");
const KEYS_DIR = path.join(COORD_DIR, "keys");
const DEFAULT_KEY_PATH = path.join(KEYS_DIR, "default.json");

export interface KeyFile {
  privateKey: string;
  address: string;
  createdAt: string;
}

/**
 * Generate a new ECDSA private key using ethers.Wallet.createRandom()
 * Returns a Wallet (not HDNodeWallet) for consistent typing.
 */
export function generateKey(): ethers.Wallet {
  const hdWallet = ethers.Wallet.createRandom();
  // Convert HDNodeWallet to plain Wallet for consistent typing
  return new ethers.Wallet(hdWallet.privateKey);
}

/**
 * Load key from ~/.coordination/keys/default.json
 */
export function loadKey(): ethers.Wallet | null {
  if (!fs.existsSync(DEFAULT_KEY_PATH)) {
    return null;
  }
  const data = JSON.parse(fs.readFileSync(DEFAULT_KEY_PATH, "utf-8")) as KeyFile;
  return new ethers.Wallet(data.privateKey);
}

/**
 * Save wallet to ~/.coordination/keys/default.json with secure permissions
 */
export function saveKey(wallet: ethers.Wallet): void {
  // Create directories with 0700 permissions
  if (!fs.existsSync(COORD_DIR)) {
    fs.mkdirSync(COORD_DIR, { mode: 0o700 });
  }
  if (!fs.existsSync(KEYS_DIR)) {
    fs.mkdirSync(KEYS_DIR, { mode: 0o700 });
  }

  const keyFile: KeyFile = {
    privateKey: wallet.privateKey,
    address: wallet.address,
    createdAt: new Date().toISOString(),
  };

  fs.writeFileSync(DEFAULT_KEY_PATH, JSON.stringify(keyFile, null, 2), {
    mode: 0o600,
  });
}

/**
 * Check if key file permissions are too open (like SSH key check)
 */
export function checkPermissions(): { ok: boolean; warning?: string } {
  if (!fs.existsSync(DEFAULT_KEY_PATH)) {
    return { ok: true };
  }

  try {
    const stats = fs.statSync(DEFAULT_KEY_PATH);
    const mode = stats.mode & 0o777;

    // Warn if group or others have any permissions
    if (mode & 0o077) {
      return {
        ok: false,
        warning: `WARNING: Key file ${DEFAULT_KEY_PATH} has permissions ${mode.toString(8)}. ` +
          `It should be 0600. Run: chmod 600 ${DEFAULT_KEY_PATH}`,
      };
    }
    return { ok: true };
  } catch {
    return { ok: true };
  }
}

/**
 * Export key file to specified path
 */
export function exportKey(destPath: string): void {
  if (!fs.existsSync(DEFAULT_KEY_PATH)) {
    throw new Error("No key found. Run 'coordination init' first.");
  }
  const resolved = path.resolve(destPath);
  fs.copyFileSync(DEFAULT_KEY_PATH, resolved);
  fs.chmodSync(resolved, 0o600);
}

/**
 * Import key file from specified path
 */
export function importKey(srcPath: string): ethers.Wallet {
  const resolved = path.resolve(srcPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Key file not found: ${resolved}`);
  }

  const data = JSON.parse(fs.readFileSync(resolved, "utf-8")) as KeyFile;
  const wallet = new ethers.Wallet(data.privateKey);

  // Validate the key data
  if (wallet.address.toLowerCase() !== data.address.toLowerCase()) {
    throw new Error("Key file address does not match derived address");
  }

  saveKey(wallet);
  return wallet;
}

/**
 * Load existing key or generate a new one
 */
export function getOrCreateKey(): ethers.Wallet {
  const existing = loadKey();
  if (existing) {
    return existing;
  }
  const wallet = generateKey();
  saveKey(wallet);
  return wallet;
}
