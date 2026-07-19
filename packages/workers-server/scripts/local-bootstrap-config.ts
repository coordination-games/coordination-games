import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export const LOCAL_TREASURY_HANDLE = 'local-tournament-treasury';

export async function writeRuntimeConfig(
  runtimeDirectory: string,
  configPath: string,
  strictLocalSettlement = true,
): Promise<string> {
  const workerDirectory = dirname(configPath);
  const runtimeConfigPath = resolve(runtimeDirectory, 'wrangler.toml');
  const mainPath = resolve(workerDirectory, 'src/index.ts');
  const migrationsDirectory = resolve(workerDirectory, 'migrations');
  await writeFile(
    runtimeConfigPath,
    `name = "ctl-server-local"
main = "${mainPath}"
compatibility_date = "2025-01-01"
compatibility_flags = ["nodejs_compat"]

[[d1_databases]]
binding = "DB"
database_name = "ctl-db"
database_id = "a16be595-731c-4b55-8c4a-d937c142c2da"
migrations_dir = "${migrationsDirectory}"

[[durable_objects.bindings]]
name = "GAME_ROOM"
class_name = "GameRoomDO"

[[durable_objects.bindings]]
name = "LOBBY"
class_name = "LobbyDO"

[[durable_objects.bindings]]
name = "TOURNAMENT"
class_name = "TournamentDO"

[[migrations]]
tag = "v1"
new_classes = ["GameRoomDO", "LobbyDO"]

[[migrations]]
tag = "v2"
new_classes = ["TournamentDO"]

[vars]
ENVIRONMENT = "production"
ADMIN_TOKEN = "local-inspector-token"
${
  strictLocalSettlement
    ? `STRICT_LOCAL_SETTLEMENT = "true"
TREASURY_AGENT_HANDLE = "${LOCAL_TREASURY_HANDLE}"
`
    : ''
}`,
  );
  return runtimeConfigPath;
}
