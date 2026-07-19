import { describe, expect, it } from 'vitest';
import { scriptedTragedyCompletion, scriptedTragedyTool } from '../scripted-tragedy-provider.js';

describe('scripted Tragedy provider', () => {
  it('selects the required bootstrap tools before taking a game action', () => {
    expect(
      scriptedTragedyTool({
        calledTools: [],
        lastTool: undefined,
        state: undefined,
        ownHandle: 'bot1-a1',
      }),
    ).toEqual({ name: 'guide', arguments: '{}' });
    expect(
      scriptedTragedyTool({
        calledTools: ['guide'],
        lastTool: 'guide',
        state: undefined,
        ownHandle: 'bot1-a1',
      }),
    ).toEqual({ name: 'state', arguments: '{}' });
  });

  it('uses its own seat to select a deterministic legal starting camp and then passes', () => {
    const base = {
      calledTools: ['guide', 'state', 'chat', 'chat'],
      lastTool: 'state',
      ownHandle: 'bot3-a1',
    };
    expect(
      scriptedTragedyTool({ ...base, state: '{"currentPhase":{"tools":["place_starting_camp"]}}' }),
    ).toEqual({ name: 'place_starting_camp', arguments: '{"intersectionId":"south"}' });
    expect(scriptedTragedyTool({ ...base, state: '{"currentPhase":{"tools":["pass"]}}' })).toEqual({
      name: 'pass',
      arguments: '{}',
    });
  });

  it('uses canonical ToolDefinition objects from the live phase envelope', () => {
    const base = {
      calledTools: ['guide', 'state', 'chat', 'chat'],
      lastTool: 'state',
      ownHandle: 'bot3-a1',
    };
    expect(
      scriptedTragedyTool({
        ...base,
        state: '{"currentPhase":{"tools":[{"name":"place_starting_camp"}]}}',
      }),
    ).toEqual({ name: 'place_starting_camp', arguments: '{"intersectionId":"south"}' });
    expect(
      scriptedTragedyTool({
        ...base,
        state: '{"currentPhase":{"tools":[{"name":"pass"}]}}',
      }),
    ).toEqual({ name: 'pass', arguments: '{}' });
  });

  it('reuses the prior current phase when the latest state omits it as unchanged', async () => {
    const completion = await scriptedTragedyCompletion({
      apiKey: '',
      baseUrl: 'http://localhost',
      model: 'scripted',
      signal: new AbortController().signal,
      tools: [],
      messages: [
        { role: 'system', content: 'You are bot1-a1, a scripted player.' },
        { role: 'tool', name: 'guide', content: '{}' },
        { role: 'tool', name: 'state', content: '{"currentPhase":{"tools":["pass"]}}' },
        { role: 'tool', name: 'chat', content: '{}' },
        { role: 'tool', name: 'chat', content: '{}' },
        { role: 'tool', name: 'state', content: '{"_unchangedKeys":["currentPhase"]}' },
      ],
    });

    expect(completion.toolCalls).toEqual([
      { id: 'scripted-pass', function: { name: 'pass', arguments: '{}' } },
    ]);
  });

  it('replaces setup tools when a later state explicitly enters the playing phase', async () => {
    const completion = await scriptedTragedyCompletion({
      apiKey: '',
      baseUrl: 'http://localhost',
      model: 'scripted',
      signal: new AbortController().signal,
      tools: [],
      messages: [
        { role: 'system', content: 'You are bot1-a1, a scripted player.' },
        { role: 'tool', name: 'guide', content: '{}' },
        {
          role: 'tool',
          name: 'state',
          content: '{"currentPhase":{"tools":["place_starting_camp"]}}',
        },
        { role: 'tool', name: 'chat', content: '{}' },
        { role: 'tool', name: 'chat', content: '{}' },
        { role: 'tool', name: 'state', content: '{"currentPhase":{"tools":["pass"]}}' },
      ],
    });

    expect(completion.toolCalls).toEqual([
      { id: 'scripted-pass', function: { name: 'pass', arguments: '{}' } },
    ]);
  });

  it('selects a DM recipient from uppercase ephemeral bot handles', () => {
    expect(
      scriptedTragedyTool({
        calledTools: ['guide', 'state', 'chat'],
        lastTool: 'chat',
        state: '{"players":["bot1-1aDF13","bot2-F199F6"]}',
        ownHandle: 'bot1-1aDF13',
      }),
    ).toEqual({
      name: 'chat',
      arguments: '{"message":"Private coordination confirmed.","scope":"bot2-F199F6"}',
    });
  });

  it('selects a mapped peer player ID for the second chat from the production prompt and state', async () => {
    const completion = await scriptedTragedyCompletion({
      apiKey: '',
      baseUrl: 'http://localhost',
      model: 'scripted',
      signal: new AbortController().signal,
      tools: [],
      messages: [
        {
          role: 'system',
          content: 'You are bot1-CCE457, an AI agent on the Coordination Games platform.',
        },
        { role: 'tool', name: 'guide', content: '{}' },
        {
          role: 'tool',
          name: 'state',
          content:
            '{"handleMap":{"aaf3e1ab-3855-4045-abd6-ddbefb9e5c1d":"bot1-CCE457","a48371ab-5eb8-4988-9c46-ac00dde76ab1":"bot2-791605"}}',
        },
        { role: 'tool', name: 'chat', content: '{}' },
      ],
    });

    expect(completion.toolCalls).toEqual([
      {
        id: 'scripted-chat',
        function: {
          name: 'chat',
          arguments:
            '{"message":"Private coordination confirmed.","scope":"a48371ab-5eb8-4988-9c46-ac00dde76ab1"}',
        },
      },
    ]);
  });

  it('acts immediately on an actionable state returned by wait', async () => {
    const completion = await scriptedTragedyCompletion({
      apiKey: '',
      baseUrl: 'http://localhost',
      model: 'scripted',
      signal: new AbortController().signal,
      tools: [],
      messages: [
        { role: 'system', content: 'You are bot1-a1, a scripted player.' },
        { role: 'tool', name: 'guide', content: '{}' },
        { role: 'tool', name: 'state', content: '{"currentPhase":{"tools":[]}}' },
        { role: 'tool', name: 'chat', content: '{}' },
        { role: 'tool', name: 'chat', content: '{}' },
        { role: 'tool', name: 'wait', content: '{"currentPhase":{"tools":["pass"]}}' },
      ],
    });

    expect(completion.toolCalls).toEqual([
      { id: 'scripted-pass', function: { name: 'pass', arguments: '{}' } },
    ]);
  });

  it('waits after an unavailable turn action instead of reusing the stale phase', async () => {
    const completion = await scriptedTragedyCompletion({
      apiKey: '',
      baseUrl: 'http://localhost',
      model: 'scripted',
      signal: new AbortController().signal,
      tools: [],
      messages: [
        { role: 'system', content: 'You are bot1-a1, a scripted player.' },
        { role: 'tool', name: 'guide', content: '{}' },
        { role: 'tool', name: 'state', content: '{"currentPhase":{"tools":["pass"]}}' },
        { role: 'tool', name: 'chat', content: '{}' },
        { role: 'tool', name: 'chat', content: '{}' },
        {
          role: 'tool',
          name: 'pass',
          content: '{"error":{"code":"WRONG_PHASE","message":"pass is unavailable"}}',
        },
      ],
    });

    expect(completion.toolCalls).toEqual([
      { id: 'scripted-wait', function: { name: 'wait', arguments: '{}' } },
    ]);
  });

  it('retains prior tools for wait diffs and clears them when wait removes the phase', async () => {
    const messages = [
      { role: 'system' as const, content: 'You are bot1-a1, a scripted player.' },
      { role: 'tool' as const, name: 'guide', content: '{}' },
      { role: 'tool' as const, name: 'state', content: '{"currentPhase":{"tools":["pass"]}}' },
      { role: 'tool' as const, name: 'chat', content: '{}' },
      { role: 'tool' as const, name: 'chat', content: '{}' },
    ];
    const pass = await scriptedTragedyCompletion({
      apiKey: '',
      baseUrl: 'http://localhost',
      model: 'scripted',
      signal: new AbortController().signal,
      tools: [],
      messages: [
        ...messages,
        { role: 'tool', name: 'wait', content: '{"_unchangedKeys":["currentPhase"]}' },
      ],
    });
    const noStaleSetup = await scriptedTragedyCompletion({
      apiKey: '',
      baseUrl: 'http://localhost',
      model: 'scripted',
      signal: new AbortController().signal,
      tools: [],
      messages: [
        ...messages,
        { role: 'tool', name: 'wait', content: '{"_removedKeys":["currentPhase"]}' },
      ],
    });

    expect(pass.toolCalls[0]?.function.name).toBe('pass');
    expect(noStaleSetup.toolCalls[0]?.function.name).toBe('wait');
  });
});
