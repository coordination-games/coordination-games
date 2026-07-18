/**
 * HTML shell + design tokens for the harness console. Server-rendered once,
 * CSP-locked via per-request nonce; all behavior lives in client.ts.
 *
 * Design system (inherited from the standalone harness console's control-room
 * language): dark paper, warm panel, amber accent, mono type, grid overlay.
 * Every color/space/radius below is a token — components reference tokens only.
 */

import { CLIENT_JS } from './client.js';

const CSS = `
:root {
  color-scheme: dark;
  --ink: #f3eddc; --muted: #b9ad91; --paper: #15130f; --panel: #211d16;
  --panel-2: #2a2419; --line: #4a3f2e; --accent: #f3b85b; --green: #8bd38a;
  --red: #ff7b6e; --blue: #86b7ff;
  --s1: 4px; --s2: 8px; --s3: 12px; --s4: 16px; --s5: 24px; --s6: 34px;
  --r1: 6px; --r2: 10px;
  --fs0: 11px; --fs1: 12.5px; --fs2: 14px; --fs3: 17px; --fs4: 22px;
  --mono: "Azeret Mono", "IBM Plex Mono", ui-monospace, Menlo, monospace;
}
* { box-sizing: border-box; }
body {
  margin: 0; min-height: 100vh; color: var(--ink); font-family: var(--mono);
  font-size: var(--fs2); line-height: 1.45;
  background:
    radial-gradient(circle at 14% 8%, rgba(243,184,91,.14), transparent 30%),
    radial-gradient(circle at 88% 18%, rgba(134,183,255,.10), transparent 28%),
    linear-gradient(135deg, #0d0c0a 0%, #19150f 50%, #0f1111 100%);
}
body::before {
  content: ""; position: fixed; inset: 0; pointer-events: none; opacity: .10;
  background-image: linear-gradient(rgba(255,255,255,.08) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255,255,255,.08) 1px, transparent 1px);
  background-size: 42px 42px;
  mask-image: radial-gradient(circle at center, black, transparent 78%);
}
main { position: relative; width: min(1480px, calc(100vw - 2 * var(--s4))); margin: 0 auto; padding: var(--s5) 0 var(--s6); }
header { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--s3); margin-bottom: var(--s5); }
header h1 { margin: 0; font-size: var(--fs4); letter-spacing: .04em; }
header h1 em { color: var(--accent); font-style: normal; }
.tagline { color: var(--muted); font-size: var(--fs1); }
.grid { display: grid; grid-template-columns: minmax(320px, 5fr) minmax(380px, 7fr); gap: var(--s4); align-items: start; }
.col { display: grid; gap: var(--s4); min-width: 0; }
section.panel {
  background: color-mix(in srgb, var(--panel) 92%, transparent);
  border: 1px solid var(--line); border-radius: var(--r2); padding: var(--s4); min-width: 0;
}
.panel > h2 {
  margin: 0 0 var(--s3); font-size: var(--fs0); text-transform: uppercase;
  letter-spacing: .18em; color: var(--accent);
}
.status-line { color: var(--muted); font-size: var(--fs1); margin: var(--s2) 0; min-height: 1.2em; }
.status-line.error { color: var(--red); }
ul.listing { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--s2); }
button {
  font: inherit; color: var(--ink); background: var(--panel-2);
  border: 1px solid var(--line); border-radius: var(--r1);
  padding: var(--s2) var(--s3); cursor: pointer; text-align: left;
}
button:hover { border-color: var(--accent); }
button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
button:disabled { opacity: .45; cursor: not-allowed; }
button.primary { background: var(--accent); color: #1a1408; font-weight: 700; }
button.danger { border-color: var(--red); color: var(--red); }
button.item { width: 100%; display: flex; justify-content: space-between; gap: var(--s2); }
button.item .meta { color: var(--muted); font-size: var(--fs0); white-space: nowrap; }
button.item[aria-pressed="true"] { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 14%, var(--panel-2)); }
.actions { display: flex; flex-wrap: wrap; gap: var(--s2); margin-top: var(--s3); }
.badge { display: inline-block; padding: 1px var(--s2); border-radius: 999px; font-size: var(--fs0); border: 1px solid var(--line); }
.badge.running { color: var(--blue); border-color: var(--blue); }
.badge.completed { color: var(--green); border-color: var(--green); }
.badge.failed { color: var(--red); border-color: var(--red); }
.badge.stopped { color: var(--muted); }
.badge.tournament { color: var(--accent); border-color: var(--accent); }
pre.log {
  margin: var(--s3) 0 0; padding: var(--s3); background: #0d0c0a; border: 1px solid var(--line);
  border-radius: var(--r1); font-size: var(--fs1); max-height: 340px; overflow: auto; white-space: pre-wrap;
  overflow-wrap: anywhere;
}
pre.log .stderr { color: var(--red); }
pre.log .system { color: var(--blue); }
dl.audit { display: grid; grid-template-columns: max-content 1fr; gap: var(--s1) var(--s3); margin: 0; font-size: var(--fs1); }
dl.audit dt { color: var(--muted); }
dl.audit dd { margin: 0; overflow-wrap: anywhere; }
table.seats { width: 100%; border-collapse: collapse; font-size: var(--fs1); margin-top: var(--s2); }
table.seats th, table.seats td { text-align: left; padding: var(--s1) var(--s2); border-bottom: 1px solid var(--line); white-space: nowrap; }
table.seats th { color: var(--muted); font-weight: 400; font-size: var(--fs0); text-transform: uppercase; letter-spacing: .1em; }
.chips { display: flex; flex-wrap: wrap; gap: var(--s2); margin-top: var(--s3); }
.subhead { color: var(--muted); font-size: var(--fs0); text-transform: uppercase; letter-spacing: .14em; margin: var(--s3) 0 var(--s1); }
@media (max-width: 1000px) { .grid { grid-template-columns: 1fr; } }
@media (max-width: 480px) {
  main { padding-top: var(--s4); }
  header h1 { font-size: var(--fs3); }
  dl.audit { grid-template-columns: 1fr; }
  dl.audit dt { margin-top: var(--s2); }
  table.seats, table.seats tbody, table.seats tr, table.seats td { display: block; }
  table.seats thead { display: none; }
  table.seats tr { border: 1px solid var(--line); border-radius: var(--r1); padding: var(--s2) var(--s3); margin-top: var(--s2); }
  table.seats td { display: grid; grid-template-columns: minmax(72px, max-content) 1fr; gap: var(--s3); border-bottom: 0; padding: var(--s1) 0; white-space: normal; overflow-wrap: anywhere; }
  table.seats td::before { content: attr(data-label); color: var(--muted); font-size: var(--fs0); text-transform: uppercase; letter-spacing: .1em; }
}
`;

export function renderPage(nonce: string, csrf: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="harness-csrf" content="${csrf}" />
<title>Harness Console — Coordination Games</title>
<link rel="icon" href="data:," />
<style nonce="${nonce}">${CSS}</style>
</head>
<body>
<main>
  <header>
    <h1>coga <em>harness console</em></h1>
    <span class="tagline">local-only · drives <code>src/index.ts run</code> · nothing leaves 127.0.0.1</span>
  </header>
  <div class="grid">
    <div class="col">
      <section class="panel" aria-labelledby="specs-h">
        <h2 id="specs-h">Campaign specs</h2>
        <p class="status-line" id="specs-status" role="status">Loading…</p>
        <ul class="listing" id="specs-list"></ul>
        <div class="actions">
          <button id="btn-dry-run" disabled>Dry-run plan</button>
          <button id="btn-launch" class="primary" disabled>Launch run</button>
          <button id="btn-preview-spec" disabled>View spec</button>
        </div>
        <pre class="log" id="spec-preview" hidden></pre>
        <div id="spec-summary" hidden></div>
      </section>
      <section class="panel" aria-labelledby="runs-h">
        <h2 id="runs-h">Console runs</h2>
        <p class="status-line" id="runs-status" role="status">No runs launched this session.</p>
        <ul class="listing" id="runs-list"></ul>
      </section>
    </div>
    <div class="col">
      <section class="panel" aria-labelledby="live-h">
        <h2 id="live-h">Live output</h2>
        <p class="status-line" id="live-status" role="status">Select or launch a run to stream its output.</p>
        <div class="actions">
          <button id="btn-stop" class="danger" disabled>Stop run</button>
        </div>
        <pre class="log" id="live-log" aria-live="polite" hidden></pre>
      </section>
      <section class="panel" aria-labelledby="artifacts-h">
        <h2 id="artifacts-h">Artifacts</h2>
        <p class="status-line" id="artifacts-status" role="status">Loading…</p>
        <div class="actions"><button id="btn-refresh-artifacts">Refresh</button></div>
        <div class="subhead">Campaigns</div>
        <ul class="listing" id="campaign-list"></ul>
        <div class="subhead">Runs</div>
        <ul class="listing" id="artifact-list"></ul>
      </section>
      <section class="panel" aria-labelledby="audit-h">
        <h2 id="audit-h">Audit</h2>
        <p class="status-line" id="audit-status" role="status">Pick an artifact to inspect its provenance.</p>
        <div id="audit-body" hidden></div>
        <div id="series-progress" hidden></div>
        <pre class="log" id="file-preview" hidden></pre>
      </section>
    </div>
  </div>
</main>
<script nonce="${nonce}">${CLIENT_JS}</script>
</body>
</html>`;
}
