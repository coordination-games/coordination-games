import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export async function writeRuntimeConfig(
  runtimeDirectory: string,
  configPath: string,
): Promise<string> {
  const workerDirectory = dirname(configPath);
  const runtimeConfigPath = resolve(runtimeDirectory, 'wrangler.toml');
  const mainPath = resolve(workerDirectory, 'src/index.ts');
  const migrationsDirectory = resolve(workerDirectory, 'migrations');
  await writeFile(
    runtimeConfigPath,
    `name = "ctl-server-local"\nmain = "${mainPath}"\ncompatibility_date = "2025-01-01"\ncompatibility_flags = ["nodejs_compat"]\n\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "ctl-db"\ndatabase_id = "a16be595-731c-4b55-8c4a-d937c142c2da"\nmigrations_dir = "${migrationsDirectory}"\n\n[[durable_objects.bindings]]\nname = "GAME_ROOM"\nclass_name = "GameRoomDO"\n\n[[durable_objects.bindings]]\nname = "LOBBY"\nclass_name = "LobbyDO"\n\n[[durable_objects.bindings]]\nname = "TOURNAMENT"\nclass_name = "TournamentDO"\n\n[[migrations]]\ntag = "v1"\nnew_classes = ["GameRoomDO", "LobbyDO"]\n\n[[migrations]]\ntag = "v2"\nnew_classes = ["TournamentDO"]\n\n[vars]\nENVIRONMENT = "production"\n`,
  );
  return runtimeConfigPath;
}
