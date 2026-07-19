import { access } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { RESUME_PROMPT } from '../../prompts.js';
import type { TranscriptEvent } from '../../types.js';
import { OpenCodeCliAgentRunner } from '../opencode.js';
import {
  argsFrom,
  isDescendantRecord,
  isRunRecord,
  options,
  recordsFrom,
  runtimeDirectoryFrom,
  stepsFrom,
  withFakeOpenCode,
} from './opencode-cli-test-fixture.js';

describe('OpenCodeCliAgentRunner', () => {
  it('Given an early idle session, when the game is unfinished, then it resumes the same session and deletes it after finishing', async () => {
    await withFakeOpenCode('resume', async ({ recordPath }) => {
      const events: TranscriptEvent[] = [];

      const result = await new OpenCodeCliAgentRunner().runSession(options(events));
      const records = await recordsFrom(recordPath);

      expect(result).toEqual({ finished: true, modelCalls: 2, reason: 'finished' });
      expect(records).toHaveLength(3);
      expect(records[0]).toMatchObject({
        kind: 'run',
        outputTokenCap: '10',
      });
      expect(argsFrom(records[0]).slice(0, 10)).toEqual([
        'run',
        '--pure',
        '--model',
        'minimax-coding-plan/MiniMax-M3',
        '--agent',
        'coga-game',
        '--variant',
        'none',
        '--format',
        'json',
      ]);
      expect(records[1]).toMatchObject({
        kind: 'run',
        args: expect.arrayContaining(['--session', 'ses_fake_opencode']),
      });
      expect(records[2]).toEqual({
        kind: 'cleanup',
        args: ['session', 'delete', 'ses_fake_opencode', '--pure'],
      });
      expect(events).toContainEqual(
        expect.objectContaining({ kind: 'session', event: 'finished' }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({ kind: 'model_response', text: 'Game finished.' }),
      );
      const runtimeDirectory = runtimeDirectoryFrom(records[0]);
      await expect(access(runtimeDirectory)).rejects.toThrow();
    });
  });

  it('Given two calls before an unfinished resume, when the limit is three, then the resumed agent receives exactly one remaining step', async () => {
    await withFakeOpenCode('remaining-steps', async ({ recordPath }) => {
      const events: TranscriptEvent[] = [];

      const result = await new OpenCodeCliAgentRunner().runSession(
        options(events, { limits: { maxModelCalls: 3, wallClockMs: 5_000 } }),
      );
      const records = await recordsFrom(recordPath);
      const runs = records.filter(isRunRecord);

      expect(runs.map(stepsFrom)).toEqual([3, 1]);
      expect(events.filter((event) => event.kind === 'model_request')).toHaveLength(3);
      expect(result).toEqual({ finished: false, modelCalls: 3, reason: 'cap' });
    });
  });

  it('Given caller cancellation with a live descendant, when aborting, then it terminates the process group and cleans session state', async () => {
    await withFakeOpenCode('hang', async ({ recordPath }) => {
      const events: TranscriptEvent[] = [];
      const controller = new AbortController();
      const runOptions = options(events, {
        signal: controller.signal,
        onEvent(event) {
          events.push(event);
          if (event.kind === 'model_request') controller.abort();
        },
      });

      const result = await new OpenCodeCliAgentRunner().runSession(runOptions);
      const records = await recordsFrom(recordPath);

      expect(result.reason).toBe('error');
      expect(events).toContainEqual(
        expect.objectContaining({ kind: 'session', event: 'cancelled' }),
      );
      const descendant = records.find(isDescendantRecord);
      expect(descendant).toBeDefined();
      if (descendant) {
        expect(descendant.processGroupId).toBe(descendant.parentPid);
        expect(descendant.cwd.replace(/^\/private/, '')).toBe(runtimeDirectoryFrom(records[0]));
        expect(() => process.kill(descendant.pid, 0)).toThrow();
      }
      expect(records).toContainEqual({
        kind: 'cleanup',
        args: ['session', 'delete', 'ses_fake_opencode', '--pure'],
      });
    });
  });

  it('Given the model-call cap, when OpenCode stops before game completion, then it returns a bounded cap without resuming', async () => {
    await withFakeOpenCode('unfinished', async ({ recordPath }) => {
      const events: TranscriptEvent[] = [];

      const result = await new OpenCodeCliAgentRunner().runSession(
        options(events, { limits: { maxModelCalls: 1, wallClockMs: 5_000 } }),
      );

      expect(result).toEqual({ finished: false, modelCalls: 1, reason: 'cap' });
      expect(events).toContainEqual(
        expect.objectContaining({
          kind: 'session',
          event: 'cap',
          detail: 'model call cap 1 reached',
        }),
      );
      const records = await recordsFrom(recordPath);
      expect(records.filter(isRunRecord)).toHaveLength(1);
    });
  });

  it('Given measured tokens exceed the per-call output setting, when model calls remain, then it resumes instead of applying a cumulative token cap', async () => {
    await withFakeOpenCode('resume', async ({ recordPath }) => {
      const events: TranscriptEvent[] = [];

      const result = await new OpenCodeCliAgentRunner().runSession(
        options(events, {
          modelConfig: {
            provider: 'opencode-cli',
            model: 'minimax-coding-plan/MiniMax-M3',
            maxCompletionTokens: 1,
          },
          limits: { maxModelCalls: 2, wallClockMs: 5_000 },
        }),
      );

      expect(result).toEqual({ finished: true, modelCalls: 2, reason: 'finished' });
      expect(events).not.toContainEqual(expect.objectContaining({ event: 'cap' }));
      const records = await recordsFrom(recordPath);
      expect(records.filter(isRunRecord)).toHaveLength(2);
    });
  });

  it('Given visible communication is incomplete, when correcting, then the same model session supplies only missing public and direct chats', async () => {
    await withFakeOpenCode('communication-correction', async ({ recordPath }) => {
      const events: TranscriptEvent[] = [];

      const result = await new OpenCodeCliAgentRunner().runSession(
        options(events, { limits: { maxModelCalls: 4, wallClockMs: 5_000 } }),
      );
      const records = await recordsFrom(recordPath);
      const runs = records.filter(isRunRecord);
      const prompts = runs.map((record) => argsFrom(record).at(-1));

      expect(result).toEqual({ finished: true, modelCalls: 4, reason: 'finished' });
      expect(prompts).toHaveLength(4);
      expect(prompts[0]).not.toContain('<communication-correction>');
      expect(prompts[1]).toContain(
        '<communication-correction>{"targetPlayerId":"player-target","publicChatSucceeded":false,"directChatSucceeded":false}</communication-correction>',
      );
      expect(prompts[1]).toContain('coga_chat with scope "all"');
      expect(prompts[1]).toContain('coga_chat with scope "player-target"');
      expect(prompts[2]).toContain(
        '<communication-correction>{"targetPlayerId":"player-target","publicChatSucceeded":true,"directChatSucceeded":false}</communication-correction>',
      );
      expect(prompts[2]).not.toContain('coga_chat with scope "all"');
      expect(prompts[2]).toContain('coga_chat with scope "player-target"');
      expect(prompts[3]).toBe(RESUME_PROMPT);
      for (const run of runs.slice(1)) {
        expect(argsFrom(run)).toEqual(expect.arrayContaining(['--session', 'ses_fake_opencode']));
      }

      const chatCalls = events.filter(
        (event): event is Extract<TranscriptEvent, { kind: 'tool_call' }> =>
          event.kind === 'tool_call' && event.name === 'coga_chat',
      );
      const chatResults = events.filter(
        (event): event is Extract<TranscriptEvent, { kind: 'tool_result' }> =>
          event.kind === 'tool_result' && event.name === 'coga_chat',
      );
      expect(chatCalls.map((event) => scopeFrom(event.args))).toEqual(['all', 'player-target']);
      expect(chatResults).toHaveLength(2);
      expect(chatResults.every((event) => !event.isError)).toBe(true);
      expect(events.filter((event) => event.kind === 'model_response')).toHaveLength(4);
      expect(
        JSON.stringify(events.filter((event) => event.kind === 'model_request')),
      ).not.toContain('communication-correction');
    });
  });

  it('Given a stalled OpenCode process, when wall-clock expires, then it terminates and reports the cap', async () => {
    await withFakeOpenCode('hang', async ({ recordPath }) => {
      const events: TranscriptEvent[] = [];

      const result = await new OpenCodeCliAgentRunner().runSession(
        options(events, { limits: { maxModelCalls: 3, wallClockMs: 500 } }),
      );

      expect(result.reason).toBe('cap');
      expect(events).toContainEqual(
        expect.objectContaining({
          kind: 'session',
          event: 'cap',
          detail: 'wall-clock limit 500ms exceeded',
        }),
      );
      const records = await recordsFrom(recordPath);
      const descendant = records.find(isDescendantRecord);
      expect(descendant).toBeDefined();
      if (descendant) expect(() => process.kill(descendant.pid, 0)).toThrow();
    });
  });
});

function scopeFrom(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null || Array.isArray(args) || !('scope' in args))
    return undefined;
  return typeof args.scope === 'string' ? args.scope : undefined;
}
