#!/usr/bin/env tsx
/**
 * Copies per-game static assets into the web package's public/games/<gameId>/
 * folder so Vite (and Cloudflare Pages) can serve them at runtime.
 *
 * Source:      packages/games/<gameId>/web/assets/
 * Destination: packages/web/public/games/<gameId>/
 *
 * Idempotent — destination is wiped before each copy. The output is a
 * regenerated artifact and should NOT be committed (see .gitignore).
 */
import { existsSync } from 'node:fs';
import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_PKG = resolve(__dirname, '..');
const GAMES_DIR = resolve(WEB_PKG, '../games');
const PUBLIC_GAMES = resolve(WEB_PKG, 'public/games');

async function main(): Promise<void> {
  if (!existsSync(GAMES_DIR)) {
    console.warn(`[sync-game-assets] games dir not found at ${GAMES_DIR}; skipping`);
    return;
  }

  // Wipe destination so deletions in source propagate.
  await rm(PUBLIC_GAMES, { recursive: true, force: true });
  await mkdir(PUBLIC_GAMES, { recursive: true });

  const entries = await readdir(GAMES_DIR);
  let copied = 0;

  for (const gameId of entries) {
    const gamePkg = resolve(GAMES_DIR, gameId);
    const gameStat = await stat(gamePkg).catch(() => null);
    if (!gameStat?.isDirectory()) continue;

    const assetsDir = resolve(gamePkg, 'web/assets');
    if (!existsSync(assetsDir)) continue;

    const dest = resolve(PUBLIC_GAMES, gameId);
    await cp(assetsDir, dest, { recursive: true });
    copied++;
    console.log(`[sync-game-assets] ${gameId}: ${assetsDir} -> ${dest}`);
  }

  console.log(`[sync-game-assets] done (${copied} game(s))`);
}

main().catch((err) => {
  console.error('[sync-game-assets] failed:', err);
  process.exit(1);
});
