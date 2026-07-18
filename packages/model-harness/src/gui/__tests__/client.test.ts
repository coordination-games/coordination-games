import { describe, expect, it } from 'vitest';
import { CLIENT_JS } from '../client.js';
import { renderPage } from '../page.js';

/**
 * The console renders untrusted text (spec names, labels, models, artifact
 * paths, error messages) with DOM nodes and textContent ONLY. The browser
 * dispatches on these property names, so their absence from the shipped
 * bundle is the enforced invariant — no HTML-string sink may exist at all.
 */

describe('console client bundle — DOM-only rendering', () => {
  it('ships zero HTML-string sinks in the client bundle', () => {
    expect(CLIENT_JS).not.toContain('innerHTML');
    expect(CLIENT_JS).not.toContain('outerHTML');
    expect(CLIENT_JS).not.toContain('insertAdjacentHTML');
    expect(CLIENT_JS).not.toContain('document.write');
  });

  it('embeds the bundle and the session CSRF token in the rendered page', () => {
    const html = renderPage('test-nonce', 'test-csrf-token');
    expect(html).toContain('name="harness-csrf" content="test-csrf-token"');
    expect(html).toContain('<script nonce="test-nonce">');
  });

  it('labels every table cell so the <=480px stacked presentation can name each value', () => {
    // The client sets data-label on each td; the mobile CSS renders it via attr(data-label).
    expect(CLIENT_JS).toContain('dataset.label');
    const html = renderPage('test-nonce', 'test-csrf-token');
    expect(html).toContain('attr(data-label)');
  });
});
