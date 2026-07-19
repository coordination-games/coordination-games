import { describe, expect, it } from 'vitest';
import { OpenCodeEventParser } from '../opencode-events.js';

const sessionID = 'ses_test_opencode';

function line(type: string, part: Record<string, unknown>): string {
  return JSON.stringify({ type, timestamp: 1, sessionID, part });
}

describe('OpenCodeEventParser', () => {
  it('Given a step boundary, when parsing, then it emits exact-model request evidence without prompt material', () => {
    const parser = new OpenCodeEventParser('bot', 'minimax-coding-plan/MiniMax-M3');

    const events = parser.consume(
      line('step_start', {
        id: 'part-start',
        sessionID,
        messageID: 'message-1',
        type: 'step-start',
      }),
    );

    expect(events).toEqual([
      expect.objectContaining({
        bot: 'bot',
        kind: 'model_request',
        model: 'minimax-coding-plan/MiniMax-M3',
        messages: { redacted: true, source: 'opencode-cli' },
        request: { model: 'minimax-coding-plan/MiniMax-M3', transport: 'opencode-cli' },
      }),
    ]);
    expect(JSON.stringify(events)).not.toContain('prompt');
    expect(parser.state()).toMatchObject({ sessionId: sessionID, modelCalls: 1 });
  });

  it('Given completed text and real step token fields, when parsing, then it emits non-empty response text and positive normalized usage', () => {
    const parser = new OpenCodeEventParser('bot', 'minimax-coding-plan/MiniMax-M3');
    parser.consume(
      line('step_start', {
        id: 'part-start',
        sessionID,
        messageID: 'message-1',
        type: 'step-start',
      }),
    );
    parser.consume(
      line('text', {
        id: 'part-text',
        sessionID,
        messageID: 'message-1',
        type: 'text',
        text: 'I will call state.',
        time: { start: 1, end: 2 },
      }),
    );

    const events = parser.consume(
      line('step_finish', {
        id: 'part-finish',
        sessionID,
        messageID: 'message-1',
        type: 'step-finish',
        reason: 'tool-calls',
        cost: 0,
        tokens: { input: 10, output: 4, reasoning: 3, cache: { read: 2, write: 1 } },
      }),
    );

    expect(events).toEqual([
      expect.objectContaining({
        kind: 'model_response',
        text: 'I will call state.',
        usage: { prompt_tokens: 13, completion_tokens: 7 },
      }),
    ]);
    expect(parser.state()).toMatchObject({ quotaTokens: 20, stopped: false });
  });

  it('Given a completed coga tool event with terminal state, when parsing, then it maps call, result, and finished detection', () => {
    const parser = new OpenCodeEventParser('bot', 'minimax-coding-plan/MiniMax-M3');

    const events = parser.consume(
      line('tool_use', {
        id: 'part-tool',
        sessionID,
        messageID: 'message-1',
        type: 'tool',
        callID: 'call-1',
        tool: 'coga_state',
        state: {
          status: 'completed',
          input: { fresh: true },
          output: '{"result":{"phase":"finished","stateVersion":9}}',
          title: 'state',
          metadata: {},
          time: { start: 1, end: 2 },
        },
      }),
    );

    expect(events).toEqual([
      expect.objectContaining({ kind: 'tool_call', name: 'coga_state', args: { fresh: true } }),
      expect.objectContaining({
        kind: 'tool_result',
        name: 'coga_state',
        result: { result: { phase: 'finished', stateVersion: 9 } },
      }),
    ]);
    expect(parser.state().finished).toBe(true);
  });

  it('Given nested visible state, when parsing, then it chooses the first active non-self stable player ID', () => {
    const parser = new OpenCodeEventParser('bot', 'minimax-coding-plan/MiniMax-M3');

    parser.consume(
      line('tool_use', {
        type: 'tool',
        tool: 'coga_state',
        state: {
          status: 'completed',
          input: {},
          output: JSON.stringify({
            result: {
              state: {
                you: { id: 'player-self' },
                scoreboard: [
                  { id: 'player-self' },
                  { id: 'player-inactive', active: false },
                  { id: 'player-target', active: true },
                  { id: 'player-later', active: true },
                ],
              },
            },
          }),
        },
      }),
    );

    expect(parser.state()).toMatchObject({
      publicChatSucceeded: false,
      directChatSucceeded: false,
      visibleTargetPlayerId: 'player-target',
    });
    expect(parser.communicationCorrection()).toEqual({
      targetPlayerId: 'player-target',
      publicChatSucceeded: false,
      directChatSucceeded: false,
    });
  });

  it('Given visible identities and chat results, when parsing, then only completed public and direct chats satisfy obligations', () => {
    const parser = new OpenCodeEventParser('bot', 'minimax-coding-plan/MiniMax-M3');
    const tool = (scope: string, status: 'completed' | 'error'): void => {
      parser.consume(
        line('tool_use', {
          type: 'tool',
          tool: 'coga_chat',
          state: {
            status,
            input: { message: 'redacted-test-message', scope },
            ...(status === 'completed' ? { output: '{"ok":true}' } : { error: 'rejected' }),
          },
        }),
      );
    };
    parser.consume(
      line('tool_use', {
        type: 'tool',
        tool: 'coga_wait',
        state: {
          status: 'completed',
          input: {},
          output: JSON.stringify({
            data: {
              you: { id: 'player-self' },
              scoreboard: [{ id: 'player-self' }, { id: 'player-target' }],
            },
          }),
        },
      }),
    );

    tool('team', 'completed');
    tool('player-target', 'error');
    expect(parser.state()).toMatchObject({
      publicChatSucceeded: true,
      directChatSucceeded: false,
    });
    expect(parser.communicationCorrection()).toEqual({
      targetPlayerId: 'player-target',
      publicChatSucceeded: true,
      directChatSucceeded: false,
    });

    tool('player-target', 'completed');
    expect(parser.state()).toMatchObject({
      publicChatSucceeded: true,
      directChatSucceeded: true,
    });
    expect(parser.communicationCorrection()).toBeUndefined();
  });

  it('Given malformed or unknown JSON events, when parsing, then it ignores them without inventing state', () => {
    const parser = new OpenCodeEventParser('bot', 'minimax-coding-plan/MiniMax-M3');

    expect(parser.consume('not-json')).toEqual([]);
    expect(parser.consume(JSON.stringify({ type: 'unknown', sessionID }))).toEqual([]);
    expect(parser.state()).toEqual({
      finished: false,
      modelCalls: 0,
      quotaTokens: 0,
      stopped: false,
      publicChatSucceeded: false,
      directChatSucceeded: false,
    });
  });
});
