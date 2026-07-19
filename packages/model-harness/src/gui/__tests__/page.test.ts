import { describe, expect, it } from 'vitest';
import { renderPage } from '../page.js';

/**
 * Regression: completed tournament game IDs are long unbroken hex strings.
 * client-audit.ts renders one `.status-line` paragraph per game
 * (`game N · <gameId> · …`), and at a 375px viewport those paragraphs
 * overflowed the audit panel (scrollWidth 497 inside a 309px box), widening
 * the whole page. The stylesheet must let unbroken identifiers wrap onto
 * multiple lines — the browser dispatches on this declaration, so its
 * presence in the shipped stylesheet is the enforced invariant. The IDs
 * must stay fully readable: no truncation, ellipsis, or hiding.
 */
function statusLineRule(html: string): string {
  const match = html.match(/\.status-line\s*\{([^}]*)\}/);
  if (!match?.[1]) throw new Error('.status-line rule missing from the console stylesheet');
  return match[1];
}

describe('console stylesheet — .status-line long game-ID wrapping', () => {
  it('wraps a long unbroken game ID fully instead of widening the page, without truncating it', () => {
    // Given a status line carrying a full-length unbroken hex game ID
    // When the console page stylesheet is rendered
    // Then .status-line permits mid-word wrapping and never clips content
    const html = renderPage('test-nonce', 'test-csrf-token');
    expect(html).toContain('class="status-line"');
    const rule = statusLineRule(html);
    expect(rule).toContain('overflow-wrap: anywhere');
    expect(rule).not.toContain('text-overflow');
    expect(rule).not.toContain('overflow: hidden');
    expect(rule).not.toContain('white-space: nowrap');
  });
});
