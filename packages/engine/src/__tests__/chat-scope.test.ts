import { describe, expect, it } from 'vitest';
import { classifyScope, validateChatScope } from '../chat-scope.js';

describe('classifyScope', () => {
  it('returns "all" for "all", undefined, and empty string', () => {
    expect(classifyScope('all')).toBe('all');
    expect(classifyScope(undefined)).toBe('all');
    expect(classifyScope('')).toBe('all');
  });
  it('returns "team" for "team"', () => {
    expect(classifyScope('team')).toBe('team');
  });
  it('returns "dm" for any player name', () => {
    expect(classifyScope('Clawdia')).toBe('dm');
    expect(classifyScope('bot-alice-0602')).toBe('dm');
  });
});

describe('validateChatScope', () => {
  it('accepts every scope when chatScopes is undefined', () => {
    expect(validateChatScope('all', undefined)).toBeNull();
    expect(validateChatScope('team', undefined)).toBeNull();
    expect(validateChatScope('Alice', undefined)).toBeNull();
  });

  it('always accepts "all" regardless of declaration', () => {
    expect(validateChatScope('all', ['dm'])).toBeNull();
    expect(validateChatScope(undefined, ['dm'])).toBeNull();
    expect(validateChatScope('', ['team'])).toBeNull();
  });

  it('accepts scopes in the allowed list', () => {
    expect(validateChatScope('Alice', ['all', 'dm'])).toBeNull();
    expect(validateChatScope('team', ['all', 'team', 'dm'])).toBeNull();
  });

  it('rejects team scope for FFA games', () => {
    const err = validateChatScope('team', ['all', 'dm']);
    expect(err).toContain('team');
    expect(err).toContain('not supported');
  });

  it('rejects DM scope when dm is disallowed', () => {
    const err = validateChatScope('Clawdia', ['all', 'team']);
    expect(err).toContain('Clawdia');
    expect(err).toContain('DM');
  });
});
