import path from 'node:path';
import { redactText } from './gui/redact.js';
import { createSeriesArtifactIo } from './series-artifact-io.js';
import {
  projectBotEvent,
  projectOutcome,
  projectRelay,
  projectResolvedConfig,
  visibleTo,
} from './series-artifact-projection.js';
import type { ArtifactWriterInput, SeriesArtifactWriter } from './series-artifact-types.js';

export { SeriesArtifactError } from './series-artifact-io.js';
export type {
  AvailableSeriesGame,
  ResolvedSeriesConfigInput,
  SeriesArtifactWriter,
  SeriesGameArtifactInput,
  SeriesManifestInput,
  SeriesManifestSeat,
  SeriesRawRelay,
} from './series-artifact-types.js';

export function createSeriesArtifactWriter(input: ArtifactWriterInput): SeriesArtifactWriter {
  const io = createSeriesArtifactIo({
    ...(input.beforeRename ? { beforeRename: input.beforeRename } : {}),
  });
  return {
    writeResolvedConfig: async (config) =>
      io.write(path.join(input.runDir, 'resolved-config.json'), projectResolvedConfig(config)),
    writeGame: async (game) => {
      const gameDir = path.join(input.runDir, 'games', String(game.gameIndex));
      const relay = game.relay.map((entry) => projectRelay(game.gameId, entry));
      const publicRelay = relay.filter((entry) => entry.scope.kind === 'all');
      await io.write(path.join(gameDir, 'relay.jsonl'), publicRelay.map(jsonLine).join(''));
      await Promise.all(
        Object.entries(game.botEvents).map(([botName, events]) =>
          io.write(
            path.join(gameDir, 'bots', `${botName}.jsonl`),
            [
              ...relay
                .filter((entry) => visibleTo(entry, game.viewers[botName]))
                .map((entry) => ({ kind: 'relay', relay: entry })),
              ...events.map((event) => projectBotEvent(event, game.gameId, game.gameIndex)),
            ]
              .map(jsonLine)
              .join(''),
          ),
        ),
      );
      const outcome = projectOutcome(game.outcome);
      await io.write(path.join(gameDir, 'manifest.json'), {
        gameId: game.gameId,
        gameIndex: game.gameIndex,
        outcome,
        standings: game.standings,
        relayCount: publicRelay.length,
      });
      return { gameId: game.gameId, outcome, standings: game.standings, relay };
    },
    writeSeries: async (series) =>
      io.write(path.join(input.runDir, 'series-manifest.json'), {
        runId: input.runId,
        kind: 'tournament',
        ...series,
      }),
    writeAnalysisInput: async (series) =>
      io.write(path.join(input.runDir, 'analysis-input.json'), {
        runId: input.runId,
        kind: 'tournament',
        status: series.status,
        gameIds: series.gameIds,
        standings: series.standings,
        usage: series.usage,
        availableGames: series.availableGames?.map((game) => ({
          ...game,
          ...(game.status === 'completed'
            ? {
                manifestPath: `games/${game.gameIndex}/manifest.json`,
                relayPath: `games/${game.gameIndex}/relay.jsonl`,
                botsPath: `games/${game.gameIndex}/bots`,
              }
            : {}),
        })),
        ...(series.error ? { error: series.error } : {}),
      }),
    writeError: async (error) =>
      io.appendJsonLine(path.join(input.runDir, 'errors.jsonl'), {
        name: error.name,
        message: redactText(error.message),
      }),
  };
}

function jsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}
