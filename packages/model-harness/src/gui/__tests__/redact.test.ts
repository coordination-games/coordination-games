import { describe, expect, it } from 'vitest';
import { redactText, redactValue } from '../redact.js';

describe('redactText — secret classes', () => {
  it('redacts bearer and basic authorization values', () => {
    // Given header-shaped text / When redacted / Then the token body disappears
    expect(redactText('Authorization: Bearer abcDEF123456789xyz')).toContain('Bearer [REDACTED]');
    expect(redactText('auth: Basic dXNlcjpwYXNzd29yZA==')).toContain('Basic [REDACTED]');
  });

  it('redacts provider-style keys (sk-…, ghp…, AKIA…)', () => {
    expect(redactText('using sk-abcdefghijkl123456')).not.toContain('sk-abcdefghijkl123456');
    expect(redactText('key AKIAABCDEFGHIJKLMNOP here')).not.toContain('AKIAABCDEFGHIJKLMNOP');
  });

  it('redacts URL userinfo credentials and sensitive query params', () => {
    const out = redactText('fetch https://user:hunter2@example.com/a?apiKey=sekrit&page=2');
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain('sekrit');
    expect(out).toContain('page=2');
  });

  it('redacts assignment-shaped secrets in env/json text', () => {
    expect(redactText('OPENROUTER_API_KEY=sk-or-v1-0123456789abcdef')).toBe(
      'OPENROUTER_API_KEY=[REDACTED]',
    );
    expect(redactText('"apiKey": "abc123def456"')).not.toContain('abc123def456');
    expect(redactText('inspectorToken=deadbeef99')).not.toContain('deadbeef99');
  });

  it('leaves non-secret look-alikes alone', () => {
    // Given counters like maxCompletionTokens / When redacted / Then untouched
    expect(redactText('maxCompletionTokens: 4000')).toBe('maxCompletionTokens: 4000');
    expect(redactText('relay events: 132')).toBe('relay events: 132');
  });
});

describe('redactValue — deep structural redaction', () => {
  it('replaces values under sensitive keys and recurses into arrays', () => {
    // Given a parsed artifact / When deep-redacted / Then secret leaves vanish
    const out = redactValue({
      apiKey: 'sk-live-123456789012',
      nested: [{ password: 'p4ss' }, { label: 'ok' }],
      count: 3,
    }) as Record<string, unknown>;
    expect(out.apiKey).toBe('[REDACTED]');
    expect((out.nested as Record<string, unknown>[])[0]?.password).toBe('[REDACTED]');
    expect((out.nested as Record<string, unknown>[])[1]?.label).toBe('ok');
    expect(out.count).toBe(3);
  });
});
