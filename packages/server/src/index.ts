// Capture the Lobster — Server entry point
import { GameServer } from './api.js';
import { getFramework } from './coordination.js';
import fs from 'fs';

const CRASH_LOG = '/tmp/ctf-crash.log';

function logCrash(label: string, err: any): void {
  const timestamp = new Date().toISOString();
  const msg = `[${timestamp}] ${label}: ${err?.message ?? err}\n${err?.stack ?? ''}\n\n`;
  // Write synchronously to file — survives even if process is dying
  try { fs.appendFileSync(CRASH_LOG, msg); } catch {}
  console.error(msg);
}

// Catch unhandled errors — log to file so we can see them after restart
process.on('uncaughtException', (err) => {
  logCrash('UNCAUGHT EXCEPTION', err);
  // Don't exit — keep the server running if possible
});

process.on('unhandledRejection', (reason) => {
  logCrash('UNHANDLED REJECTION', reason);
});

// Log clean exits too
process.on('exit', (code) => {
  logCrash('PROCESS EXIT', { message: `Exit code: ${code}`, stack: new Error().stack });
});

process.on('SIGTERM', () => {
  logCrash('SIGTERM', { message: 'Received SIGTERM' });
});

process.on('SIGINT', () => {
  logCrash('SIGINT', { message: 'Received SIGINT' });
});

const port = Number(process.env.PORT) || 3000;
const server = new GameServer();
server.listen(port);

// Initialize the coordination framework (registers game plugins)
const framework = getFramework();
console.log(`[Coordination] Game plugins available: ${framework.listGameTypes().join(', ')}`);
