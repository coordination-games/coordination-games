import { promises as fs } from 'node:fs';
import path from 'node:path';
import { buildJudgePrompt } from './analysis-prompt.js';
import { callJudge } from './analysis-provider.js';
import { extractAnalysisJson } from './analysis-report.js';
import { buildPerBotTimelines } from './analysis-timeline.js';
import { loadAnalysisInputs } from './series-analysis.js';

export type {
  AnalysisReport,
  BetrayalRecord,
  BrokenPledgeRecord,
  CoordinationRecord,
  DeceptionRecord,
  NotableMoment,
  PerBotRecord,
} from './analysis-report.js';

export type AnalyzeOptions = {
  readonly model: string;
};

export async function analyzeRun(runDir: string, options: AnalyzeOptions): Promise<void> {
  const { manifest, relayLines, botTranscripts } = await loadAnalysisInputs(runDir);
  const timelines = buildPerBotTimelines(botTranscripts, manifest);
  const prompt = buildJudgePrompt(manifest, relayLines, timelines);
  const report = extractAnalysisJson(await callJudge(options.model, prompt));
  await fs.writeFile(
    path.join(runDir, 'analysis.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8',
  );
  console.log(`[analyze] analysis.json written to ${runDir}`);
}
