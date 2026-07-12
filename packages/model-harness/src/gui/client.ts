/**
 * Browser client for the harness console, shipped as an inline nonce'd script.
 * Plain DOM + fetch + EventSource — no framework, no external assets. The
 * string deliberately avoids backticks/interpolation so it can live safely
 * inside the page template literal.
 */

export const CLIENT_JS = String.raw`
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var state = { specId: null, specName: null, runId: null, es: null, artifactId: null };

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function setStatus(id, text, isError) {
    var el = $(id);
    el.textContent = text;
    el.classList.toggle('error', Boolean(isError));
  }
  function getJson(url) {
    return fetch(url).then(function (res) {
      return res.json().then(function (body) {
        if (!res.ok) throw new Error(body && body.error ? body.error : 'HTTP ' + res.status);
        return body;
      });
    });
  }
  function postJson(url, payload) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
    }).then(function (res) {
      return res.json().then(function (body) {
        if (!res.ok) throw new Error(body && body.error ? body.error : 'HTTP ' + res.status);
        return body;
      });
    });
  }
  function itemButton(label, meta, pressed) {
    return '<button class="item" aria-pressed="' + (pressed ? 'true' : 'false') + '">' +
      '<span>' + esc(label) + '</span><span class="meta">' + esc(meta) + '</span></button>';
  }

  // ── Specs ────────────────────────────────────────────────────────────────
  function loadSpecs() {
    setStatus('specs-status', 'Loading…');
    getJson('/api/specs').then(function (specs) {
      var list = $('specs-list');
      list.innerHTML = '';
      if (specs.length === 0) {
        setStatus('specs-status', 'No YAML specs found under runs/ or examples/.');
        return;
      }
      setStatus('specs-status', specs.length + ' spec(s) discovered.');
      specs.forEach(function (spec) {
        var li = document.createElement('li');
        li.innerHTML = itemButton(spec.name, spec.root, spec.id === state.specId);
        li.firstChild.addEventListener('click', function () { selectSpec(spec, list); });
        list.appendChild(li);
      });
    }).catch(function (err) { setStatus('specs-status', String(err.message || err), true); });
  }
  function selectSpec(spec, list) {
    state.specId = spec.id;
    state.specName = spec.name;
    list.querySelectorAll('button').forEach(function (b) { b.setAttribute('aria-pressed', 'false'); });
    var buttons = list.querySelectorAll('button');
    for (var i = 0; i < buttons.length; i++) {
      if (buttons[i].firstChild.textContent === spec.name) buttons[i].setAttribute('aria-pressed', 'true');
    }
    ['btn-dry-run', 'btn-launch', 'btn-preview-spec'].forEach(function (id) { $(id).disabled = false; });
    setStatus('specs-status', 'Selected ' + spec.name + '.');
    $('spec-preview').hidden = true;
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
      list.innerHTML = '';
      setStatus('runs-status', runs.length === 0
        ? 'No runs launched this session.'
        : runs.length + ' run(s) this session (kept in memory only).');
      runs.forEach(function (run) {
        var li = document.createElement('li');
        li.innerHTML = itemButton(run.kind + ' · ' + run.specName, run.status, run.id === state.runId);
        li.firstChild.addEventListener('click', function () { attachRun(run.id); });
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
      var span = document.createElement('span');
      span.className = entry.stream;
      span.textContent = entry.text;
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

  // ── Artifacts + audit ────────────────────────────────────────────────────
  function loadArtifacts() {
    setStatus('artifacts-status', 'Scanning artifact roots…');
    getJson('/api/artifacts').then(function (index) {
      renderArtifactList('campaign-list', index.campaigns, function (c) {
        return { label: c.name, meta: c.root + ' · ' + c.runDirs + ' run dir(s)' };
      });
      renderArtifactList('artifact-list', index.runs, function (r) {
        return { label: (r.campaign ? r.campaign + '/' : '') + r.name, meta: r.root + (r.hasAnalysis ? ' · analyzed' : '') };
      });
      setStatus('artifacts-status', index.campaigns.length + ' campaign(s), ' + index.runs.length + ' run dir(s).');
      if (index.campaigns.length + index.runs.length === 0) {
        setStatus('artifacts-status', 'No artifacts yet — launch a run or check runs/out/.');
      }
    }).catch(function (err) { setStatus('artifacts-status', String(err.message || err), true); });
  }
  function renderArtifactList(elId, entries, shape) {
    var list = $(elId);
    list.innerHTML = '';
    entries.forEach(function (entry) {
      var s = shape(entry);
      var li = document.createElement('li');
      li.innerHTML = itemButton(s.label, s.meta, entry.id === state.artifactId);
      li.firstChild.addEventListener('click', function () { inspect(entry.id); });
      list.appendChild(li);
    });
  }
  function auditRow(dt, dd) { return '<dt>' + esc(dt) + '</dt><dd>' + esc(dd == null ? '—' : dd) + '</dd>'; }
  function inspect(id) {
    state.artifactId = id;
    setStatus('audit-status', 'Inspecting…');
    $('file-preview').hidden = true;
    getJson('/api/artifacts/inspect?id=' + encodeURIComponent(id)).then(function (a) {
      var html = '<dl class="audit">' +
        auditRow('path', a.path) + auditRow('modified', a.modifiedAt) +
        auditRow('run id', a.identifiers.runId) + auditRow('lobby id', a.identifiers.lobbyId) +
        auditRow('game id', a.identifiers.gameId) + auditRow('game', a.identifiers.game) +
        auditRow('outcome', a.outcome ? (a.outcome.phase || '?') + (a.outcome.winnerLabel ? ' · winner ' + a.outcome.winnerLabel : '') : null) +
        auditRow('relay events', a.relay ? a.relay.lines + (a.relay.truncated ? '+ (capped)' : '') : null) +
        auditRow('analysis', a.analysis ? Object.keys(a.analysis.sections).map(function (k) { return k + ':' + a.analysis.sections[k]; }).join(' ') || 'present' : 'absent') +
        '</dl>';
      if (a.seats.length > 0) {
        html += '<table class="seats"><thead><tr><th>bot</th><th>persona</th><th>model</th><th>backend</th></tr></thead><tbody>';
        a.seats.forEach(function (s) {
          html += '<tr><td>' + esc(s.bot) + '</td><td>' + esc(s.persona) + '</td><td>' + esc(s.model) + '</td><td>' + esc(s.backend) + '</td></tr>';
        });
        html += '</tbody></table>';
      }
      a.bots.forEach(function (b) {
        html += '<div class="subhead">' + esc(b.file) + ' — ' + b.lines + ' event(s)' + (b.truncated ? ' (capped)' : '') + '</div>';
      });
      if (a.errors.length > 0) {
        html += '<div class="subhead">parse/read issues</div>';
        a.errors.forEach(function (e) { html += '<p class="status-line error">' + esc(e.file) + ': ' + esc(e.message) + '</p>'; });
      }
      html += '<div class="chips">';
      ['campaign.json', 'manifest.json', 'analysis.json', 'relay.jsonl'].forEach(function (f) {
        html += '<button data-file="' + esc(f) + '">' + esc(f) + '</button>';
      });
      a.bots.forEach(function (b) { html += '<button data-file="' + esc(b.file) + '">' + esc(b.file) + '</button>'; });
      html += '</div>';
      var body = $('audit-body');
      body.innerHTML = html;
      body.hidden = false;
      body.querySelectorAll('button[data-file]').forEach(function (btn) {
        btn.addEventListener('click', function () { previewFile(id, btn.getAttribute('data-file')); });
      });
      setStatus('audit-status', 'Audit of ' + a.name + ' (all previews redacted).');
      loadArtifacts();
    }).catch(function (err) { setStatus('audit-status', String(err.message || err), true); });
  }
  function previewFile(id, file) {
    setStatus('audit-status', 'Loading ' + file + '…');
    getJson('/api/artifacts/preview?id=' + encodeURIComponent(id) + '&file=' + encodeURIComponent(file)).then(function (p) {
      var pre = $('file-preview');
      pre.textContent = p.text + (p.truncated ? '\n… [truncated]' : '');
      pre.hidden = false;
      setStatus('audit-status', file + ' (redacted' + (p.truncated ? ', truncated' : '') + ').');
    }).catch(function (err) { setStatus('audit-status', String(err.message || err), true); });
  }

  $('btn-dry-run').addEventListener('click', function () { startRun('dry-run'); });
  $('btn-launch').addEventListener('click', function () { startRun('run'); });
  $('btn-preview-spec').addEventListener('click', previewSpec);
  $('btn-stop').addEventListener('click', stopRun);
  $('btn-refresh-artifacts').addEventListener('click', loadArtifacts);

  loadSpecs();
  refreshRuns();
  loadArtifacts();
})();
`;
