import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cogaServeCommand } from '../coga-client.js';
import { BASE_PROTOCOL_PROMPT, communicationCorrectionPrompt, RESUME_PROMPT } from '../prompts.js';
import type { AgentRunner, RunSessionOptions, SessionResult } from '../types.js';
import type { CommunicationCorrection } from './opencode-communication.js';
import {
  buildOpenCodeArgs,
  buildOpenCodeConfig,
  buildOpenCodeEnvironment,
} from './opencode-config.js';
import { OpenCodeEventParser } from './opencode-events.js';
import { deleteOpenCodeSession, runOpenCodeProcess } from './opencode-process.js';

const DEFAULT_OUTPUT_TOKEN_CAP = 4_096;

export class OpenCodeCliAgentRunner implements AgentRunner {
  async runSession(options: RunSessionOptions): Promise<SessionResult> {
    const startedAt = Date.now();
    options.onEvent({
      t: startedAt,
      bot: options.botName,
      kind: 'session',
      event: 'start',
      detail: options.model,
    });
    if (options.modelConfig?.provider !== 'opencode-cli') {
      return this.failure(options, 0, 'OpenCodeProfileRequired');
    }
    const runtimeDirectory = await mkdtemp(path.join(tmpdir(), 'coga-opencode-seat-'));
    const parser = new OpenCodeEventParser(options.botName, options.model);
    const outputTokenCap = options.modelConfig.maxCompletionTokens ?? DEFAULT_OUTPUT_TOKEN_CAP;
    const command = process.env.OPENCODE_BIN ?? 'opencode';
    const coga = cogaServeCommand(options.privateKey, options.botName, options.server);
    const deadline = startedAt + options.limits.wallClockMs;
    let result: SessionResult = { finished: false, modelCalls: 0, reason: 'error' };
    let prompt = BASE_PROTOCOL_PROMPT(options.botName);
    let activeCorrectionKey: string | undefined;
    let environment: NodeJS.ProcessEnv | undefined;

    try {
      while (Date.now() < deadline) {
        const stateBefore = parser.state();
        let pendingCorrection: CommunicationCorrection | undefined;
        const config = buildOpenCodeConfig({
          coga,
          cogaWorkingDirectory: process.cwd(),
          model: options.model,
          systemPrompt: options.systemPrompt,
          maxModelCalls: options.limits.maxModelCalls - stateBefore.modelCalls,
          ...(options.disablePlugins ? { disablePlugins: options.disablePlugins } : {}),
        });
        environment = buildOpenCodeEnvironment({
          config,
          outputTokenCap,
          baseEnvironment: process.env,
        });
        const processResult = await runOpenCodeProcess({
          command,
          args: buildOpenCodeArgs({
            model: options.model,
            prompt,
            runtimeDirectory,
            ...(stateBefore.sessionId ? { sessionId: stateBefore.sessionId } : {}),
            ...(options.modelConfig.reasoningEffort
              ? { variant: options.modelConfig.reasoningEffort }
              : {}),
          }),
          cwd: runtimeDirectory,
          environment,
          timeoutMs: Math.max(1, deadline - Date.now()),
          ...(options.signal ? { signal: options.signal } : {}),
          onLine: (line) => {
            const events = parser.consume(line);
            for (const event of events) options.onEvent(event);
            const state = parser.state();
            if (state.modelCalls > options.limits.maxModelCalls) return true;
            const correction = parser.communicationCorrection();
            if (
              correction &&
              correctionKey(correction) !== activeCorrectionKey &&
              events.some((event) => event.kind === 'model_response')
            ) {
              pendingCorrection = correction;
              return true;
            }
            return false;
          },
        });
        const state = parser.state();
        if (processResult.cancelled || options.signal?.aborted) {
          result = this.cancelled(options, state.modelCalls);
          break;
        }
        if (processResult.timedOut || Date.now() >= deadline) {
          result = this.cap(
            options,
            state.modelCalls,
            `wall-clock limit ${options.limits.wallClockMs}ms exceeded`,
          );
          break;
        }
        if (state.finished) {
          options.onEvent({
            t: Date.now(),
            bot: options.botName,
            kind: 'session',
            event: 'finished',
          });
          result = { finished: true, modelCalls: state.modelCalls, reason: 'finished' };
          break;
        }
        if (state.modelCalls >= options.limits.maxModelCalls) {
          result = this.cap(
            options,
            state.modelCalls,
            `model call cap ${options.limits.maxModelCalls} reached`,
          );
          break;
        }
        if (processResult.stopped && pendingCorrection && state.sessionId) {
          this.resume(options, 'communication-correction');
          prompt = communicationCorrectionPrompt(pendingCorrection);
          activeCorrectionKey = correctionKey(pendingCorrection);
          continue;
        }
        if (processResult.exitCode !== 0 || !state.sessionId) {
          result = this.failure(options, state.modelCalls, 'OpenCodeProcessError');
          break;
        }
        const remainingCorrection = parser.communicationCorrection();
        this.resume(options, remainingCorrection ? 'communication-correction' : 'resume');
        prompt = remainingCorrection
          ? communicationCorrectionPrompt(remainingCorrection)
          : RESUME_PROMPT;
        activeCorrectionKey = remainingCorrection ? correctionKey(remainingCorrection) : undefined;
      }
    } catch (error) {
      result = this.failure(
        options,
        parser.state().modelCalls,
        error instanceof Error ? error.name : 'OpenCodeRuntimeError',
      );
    }

    try {
      const sessionId = parser.state().sessionId;
      if (sessionId && environment) {
        await deleteOpenCodeSession({ command, cwd: runtimeDirectory, environment, sessionId });
      }
    } catch (error) {
      result = this.failure(
        options,
        parser.state().modelCalls,
        error instanceof Error ? error.name : 'OpenCodeCleanupError',
      );
    } finally {
      await rm(runtimeDirectory, { recursive: true, force: true });
    }
    return result;
  }

  private cap(options: RunSessionOptions, modelCalls: number, detail: string): SessionResult {
    options.onEvent({
      t: Date.now(),
      bot: options.botName,
      kind: 'session',
      event: 'cap',
      detail,
    });
    return { finished: false, modelCalls, reason: 'cap' };
  }

  private resume(options: RunSessionOptions, detail: string): void {
    options.onEvent({
      t: Date.now(),
      bot: options.botName,
      kind: 'session',
      event: 'start',
      detail,
    });
  }

  private cancelled(options: RunSessionOptions, modelCalls: number): SessionResult {
    options.onEvent({
      t: Date.now(),
      bot: options.botName,
      kind: 'session',
      event: 'cancelled',
    });
    return { finished: false, modelCalls, reason: 'error' };
  }

  private failure(options: RunSessionOptions, modelCalls: number, detail: string): SessionResult {
    options.onEvent({
      t: Date.now(),
      bot: options.botName,
      kind: 'session',
      event: 'error',
      detail,
    });
    return { finished: false, modelCalls, reason: 'error' };
  }
}

function correctionKey(correction: CommunicationCorrection): string {
  return JSON.stringify(correction);
}
