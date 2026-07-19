import { describe, expect, it } from 'vitest';
import { scriptedTragedyCompletion } from '../scripted-tragedy-provider.js';

describe('scripted Tragedy provider scoreboard recipient', () => {
  it('selects a different scoreboard player ID when live state omits the handle map', async () => {
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
            '{"you":{"id":"aaf3e1ab-3855-4045-abd6-ddbefb9e5c1d"},"scoreboard":[{"id":"aaf3e1ab-3855-4045-abd6-ddbefb9e5c1d"},{"id":"a48371ab-5eb8-4988-9c46-ac00dde76ab1"}]}',
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
});
