import { describe, expect, it } from 'vitest';
import { backendForModel, claudeCliModel } from '../types.js';

describe('Lucian model routing compatibility', () => {
  it.each([
    ['openrouter/anthropic/claude-sonnet', 'openrouter'],
    ['anthropic/claude-haiku', 'claude'],
    ['claude/claude-sonnet', 'claude'],
    ['claude', 'claude'],
    ['haiku', 'claude'],
    ['sonnet', 'claude'],
    ['opus', 'claude'],
    ['claude-opus-4-8', 'claude'],
    ['  CLAUDE-HAIKU-4-5  ', 'claude'],
    ['openai/gpt-4o', 'openrouter'],
    ['minimax/minimax-m2', 'openrouter'],
    ['google/gemini-2.5-pro', 'openrouter'],
  ])('Given model %s, when deriving its backend, then it uses %s', (model, backend) => {
    expect(backendForModel(model)).toBe(backend);
  });

  it.each([
    ['anthropic/claude-haiku', 'haiku'],
    ['claude/claude-sonnet', 'sonnet'],
    ['CLAUDE/CLAUDE-OPUS', 'opus'],
    ['haiku', 'haiku'],
    ['claude-haiku-4-5', 'claude-haiku-4-5'],
    ['  claude-opus-4-8  ', 'claude-opus-4-8'],
    ['openrouter/anthropic/claude-sonnet', 'openrouter/anthropic/claude-sonnet'],
  ])('Given Claude CLI model %s, when normalizing it, then it returns %s', (model, expected) => {
    expect(claudeCliModel(model)).toBe(expected);
  });
});
