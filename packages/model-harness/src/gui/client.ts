/**
 * Browser client for the harness console, shipped as an inline nonce'd script.
 * Plain DOM + fetch + EventSource — no framework, no external assets, and NO
 * HTML-string sinks: every untrusted value (spec names, labels, models, paths,
 * error text) is rendered via createElement/textContent. The fragments below
 * share ONE IIFE scope (function declarations hoist across fragment
 * boundaries) and avoid backticks/interpolation so the result can live safely
 * inside the page template literal.
 */

import { CLIENT_AUDIT_JS } from './client-audit.js';
import { CLIENT_SUMMARY_JS } from './client-summary.js';

const CORE_JS = String.raw`
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var state = { specId: null, specName: null, runId: null, es: null, artifactId: null };
  var csrfMeta = document.querySelector('meta[name="harness-csrf"]');
  var CSRF = csrfMeta ? csrfMeta.getAttribute('content') : '';

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }
  function dtdd(dl, label, value) {
    dl.appendChild(el('dt', null, label));
    dl.appendChild(el('dd', null, value == null ? '—' : String(value)));
  }
  function buildTable(headers, rows) {
    var table = el('table', 'seats', null);
    var thead = el('thead', null, null);
    var hrow = el('tr', null, null);
    headers.forEach(function (h) { hrow.appendChild(el('th', null, h)); });
    thead.appendChild(hrow);
    table.appendChild(thead);
    var tbody = el('tbody', null, null);
    rows.forEach(function (cells) {
      var row = el('tr', null, null);
      cells.forEach(function (v, i) {
        var td = el('td', null, v == null ? '—' : String(v));
        td.dataset.label = headers[i];
        row.appendChild(td);
      });
      tbody.appendChild(row);
    });
    table.appendChild(tbody);
    return table;
  }
  function itemButton(label, meta, pressed, onClick) {
    var btn = el('button', 'item', null);
    btn.setAttribute('aria-pressed', pressed ? 'true' : 'false');
    btn.appendChild(el('span', null, label));
    btn.appendChild(el('span', 'meta', meta));
    btn.addEventListener('click', onClick);
    return btn;
  }
  function setStatus(id, text, isError) {
    var line = $(id);
    line.textContent = text;
    line.classList.toggle('error', Boolean(isError));
  }
  function describeBody(status, text) {
    if (!text) return 'HTTP ' + status + ' — empty response';
    var kind = /^\s*</.test(text) ? 'non-JSON (HTML) response' : 'non-JSON response';
    return 'HTTP ' + status + ' — ' + kind + ', ' + text.length + ' bytes';
  }
  function parseResponse(res) {
    return res.text().then(function (text) {
      var body = null;
      try { body = JSON.parse(text); } catch (ignored) { body = null; }
      if (!res.ok) throw new Error(body && body.error ? body.error : describeBody(res.status, text));
      if (body == null || typeof body !== 'object') throw new Error(describeBody(res.status, text));
      return body;
    });
  }
  function getJson(url) { return fetch(url).then(parseResponse); }
  function postJson(url, payload) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-harness-csrf': CSRF },
      body: JSON.stringify(payload || {}),
    }).then(parseResponse);
  }

  // ── Specs ────────────────────────────────────────────────────────────────
  function loadSpecs() {
    setStatus('specs-status', 'Loading…');
    getJson('/api/specs').then(function (specs) {
      var list = $('specs-list');
      list.replaceChildren();
      if (specs.length === 0) {
        setStatus('specs-status', 'No YAML specs found under runs/ or examples/.');
        return;
      }
      setStatus('specs-status', specs.length + ' spec(s) discovered.');
      specs.forEach(function (spec) {
        var li = el('li', null, null);
        li.appendChild(itemButton(spec.name, spec.root, spec.id === state.specId, function () {
          selectSpec(spec, list);
        }));
        list.appendChild(li);
      });
    }).catch(function (err) { setStatus('specs-status', String(err.message || err), true); });
  }
  function selectSpec(spec, list) {
    state.specId = spec.id;
    state.specName = spec.name;
    list.querySelectorAll('button').forEach(function (b) {
      b.setAttribute('aria-pressed', b.firstChild.textContent === spec.name ? 'true' : 'false');
    });
    ['btn-dry-run', 'btn-launch', 'btn-preview-spec'].forEach(function (id) { $(id).disabled = false; });
    setStatus('specs-status', 'Selected ' + spec.name + '.');
    $('spec-preview').hidden = true;
    loadSummary(spec.id);
  }
  function previewSpec() {
    if (!state.specId) return;
    setStatus('specs-status', 'Loading spec preview…');
    getJson('/api/specs/preview?id=' + encodeURIComponent(state.specId)).then(function (p) {
      var pre = $('spec-preview');
      pre.textContent = p.text + (p.truncated ? '\n… [truncated]' : '');
      pre.hidden = false;
      setStatus('specs-status', 'Showing ' + p.name + ' (redacted).');
    }).catch(function (err) { setStatus('specs-status', String(err.message || err), true); });
  }

  // ── Runs + live output ───────────────────────────────────────────────────
  function startRun(kind) {
    if (!state.specId) return;
    setStatus('live-status', 'Starting ' + kind + ' for ' + state.specName + '…');
    postJson('/api/runs', { specId: state.specId, kind: kind }).then(function (run) {
      attachRun(run.id);
      refreshRuns();
    }).catch(function (err) { setStatus('live-status', String(err.message || err), true); });
  }
  function refreshRuns() {
    getJson('/api/runs').then(function (runs) {
      var list = $('runs-list');
      list.replaceChildren();
      setStatus('runs-status', runs.length === 0
        ? 'No runs launched this session.'
        : runs.length + ' run(s) this session (kept in memory only).');
      runs.forEach(function (run) {
        var li = el('li', null, null);
        li.appendChild(itemButton(run.kind + ' · ' + run.specName, run.status, run.id === state.runId, function () {
          attachRun(run.id);
        }));
        list.appendChild(li);
      });
    }).catch(function (err) { setStatus('runs-status', String(err.message || err), true); });
  }
  function attachRun(runId) {
    if (state.es) { state.es.close(); state.es = null; }
    state.runId = runId;
    var log = $('live-log');
    log.textContent = '';
    log.hidden = false;
    setStatus('live-status', 'Streaming run ' + runId.slice(0, 8) + '…');
    var es = new EventSource('/api/runs/' + runId + '/events');
    state.es = es;
    es.addEventListener('status', function (ev) {
      var run = JSON.parse(ev.data);
      setStatus('live-status', run.kind + ' of ' + run.specName + ' — ' + run.status +
        (run.exitCode != null ? ' (exit ' + run.exitCode + ')' : ''));
      $('btn-stop').disabled = run.status !== 'running';
      if (run.status !== 'running') { es.close(); state.es = null; refreshRuns(); loadArtifacts(); }
    });
    es.addEventListener('log', function (ev) {
      var entry = JSON.parse(ev.data);
      var span = el('span', entry.stream, entry.text);
      log.appendChild(span);
      log.scrollTop = log.scrollHeight;
    });
    es.onerror = function () { setStatus('live-status', 'Event stream closed.', false); };
  }
  function stopRun() {
    if (!state.runId) return;
    postJson('/api/runs/' + state.runId + '/stop').then(function () {
      setStatus('live-status', 'Stop requested (SIGTERM, then SIGKILL after grace).');
    }).catch(function (err) { setStatus('live-status', String(err.message || err), true); });
  }
`;

const TAIL_JS = `
  $('btn-dry-run').addEventListener('click', function () { startRun('dry-run'); });
  $('btn-launch').addEventListener('click', function () { startRun('run'); });
  $('btn-preview-spec').addEventListener('click', previewSpec);
  $('btn-stop').addEventListener('click', stopRun);
  $('btn-refresh-artifacts').addEventListener('click', loadArtifacts);

  loadSpecs();
  refreshRuns();
  loadArtifacts();
`;

export const CLIENT_JS = `\n(function () {${CORE_JS}${CLIENT_AUDIT_JS}${CLIENT_SUMMARY_JS}${TAIL_JS}})();\n`;
