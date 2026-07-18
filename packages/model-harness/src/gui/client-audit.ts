/**
 * Console client fragment: artifact discovery, run-dir audit, redacted file
 * previews, and private-safe series progression. Runs inside the core
 * fragment's IIFE scope ($, state, getJson, setStatus, el, dtdd, buildTable,
 * itemButton). All untrusted values are rendered as inert text nodes.
 */

export const CLIENT_AUDIT_JS = String.raw`
  // ── Artifacts + audit ────────────────────────────────────────────────────
  function loadArtifacts() {
    setStatus('artifacts-status', 'Scanning artifact roots…');
    getJson('/api/artifacts').then(function (index) {
      renderArtifactList('campaign-list', index.campaigns, function (c) {
        return { label: c.name, meta: c.root + ' · ' + c.runDirs + ' run dir(s)' };
      });
      renderArtifactList('artifact-list', index.runs, function (r) {
        return {
          label: (r.campaign ? r.campaign + '/' : '') + r.name,
          meta: r.root + (r.hasSeries ? ' · series' : '') + (r.hasAnalysis ? ' · analyzed' : ''),
        };
      });
      setStatus('artifacts-status', index.campaigns.length + ' campaign(s), ' + index.runs.length + ' run dir(s).');
      if (index.campaigns.length + index.runs.length === 0) {
        setStatus('artifacts-status', 'No artifacts yet — launch a run or check runs/out/.');
      }
    }).catch(function (err) { setStatus('artifacts-status', String(err.message || err), true); });
  }
  function renderArtifactList(elId, entries, shape) {
    var list = $(elId);
    list.replaceChildren();
    entries.forEach(function (entry) {
      var s = shape(entry);
      var li = el('li', null, null);
      li.appendChild(itemButton(s.label, s.meta, entry.id === state.artifactId, function () {
        inspect(entry.id);
      }));
      list.appendChild(li);
    });
  }
  function inspect(id) {
    state.artifactId = id;
    setStatus('audit-status', 'Inspecting…');
    $('file-preview').hidden = true;
    $('series-progress').hidden = true;
    getJson('/api/artifacts/inspect?id=' + encodeURIComponent(id)).then(function (a) {
      var nodes = [];
      var dl = el('dl', 'audit', null);
      dtdd(dl, 'path', a.path);
      dtdd(dl, 'modified', a.modifiedAt);
      dtdd(dl, 'run id', a.identifiers.runId);
      dtdd(dl, 'lobby id', a.identifiers.lobbyId);
      dtdd(dl, 'game id', a.identifiers.gameId);
      dtdd(dl, 'game', a.identifiers.game);
      dtdd(dl, 'outcome', a.outcome
        ? (a.outcome.phase || '?') + (a.outcome.winnerLabel ? ' · winner ' + a.outcome.winnerLabel : '')
        : null);
      dtdd(dl, 'relay events', a.relay ? a.relay.lines + (a.relay.truncated ? '+ (capped)' : '') : null);
      dtdd(dl, 'analysis', a.analysis
        ? Object.keys(a.analysis.sections).map(function (k) { return k + ':' + a.analysis.sections[k]; }).join(' ') || 'present'
        : 'absent');
      nodes.push(dl);
      if (a.seats.length > 0) {
        nodes.push(buildTable(['bot', 'persona', 'model', 'backend'], a.seats.map(function (s) {
          return [s.bot, s.persona, s.model, s.backend];
        })));
      }
      a.bots.forEach(function (b) {
        nodes.push(el('div', 'subhead', b.file + ' — ' + b.lines + ' event(s)' + (b.truncated ? ' (capped)' : '')));
      });
      if (a.errors.length > 0) {
        nodes.push(el('div', 'subhead', 'parse/read issues'));
        a.errors.forEach(function (e) { nodes.push(el('p', 'status-line error', e.file + ': ' + e.message)); });
      }
      var chips = el('div', 'chips', null);
      ['campaign.json', 'manifest.json', 'analysis.json', 'relay.jsonl']
        .concat(a.bots.map(function (b) { return b.file; }))
        .forEach(function (file) {
          var btn = el('button', null, file);
          btn.addEventListener('click', function () { previewFile(id, file); });
          chips.appendChild(btn);
        });
      nodes.push(chips);
      var body = $('audit-body');
      body.replaceChildren.apply(body, nodes);
      body.hidden = false;
      setStatus('audit-status', 'Audit of ' + a.name + ' (all previews redacted).');
      loadSeries(id);
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

  // ── Series progression (private-safe, tournament dirs only) ──────────────
  var seriesTimer = null;
  function loadSeries(id) {
    getJson('/api/artifacts/series?id=' + encodeURIComponent(id)).then(function (series) {
      renderSeries(id, series);
    }).catch(function () { $('series-progress').hidden = true; });
  }
  function renderSeries(id, series) {
    var box = $('series-progress');
    if (seriesTimer) { clearTimeout(seriesTimer); seriesTimer = null; }
    if (!series || state.artifactId !== id) { box.hidden = true; return; }
    box.textContent = '';
    var head = el('div', 'subhead', null);
    head.appendChild(el('span', null, 'series progress '));
    head.appendChild(el('span', 'badge tournament', 'tournament'));
    box.appendChild(head);
    var dl = el('dl', 'audit', null);
    dtdd(dl, 'status', series.status);
    dtdd(dl, 'games completed', series.games.length + ' / ' + (series.seriesLength == null ? '?' : series.seriesLength));
    if (series.gameIds.length > 0) dtdd(dl, 'game ids', series.gameIds.join(', '));
    if (series.standings.length > 0) {
      dtdd(dl, 'standings', series.standings.map(function (s) {
        return s.playerId + (s.rank == null ? '' : ' (#' + s.rank + ')');
      }).join(', '));
    }
    var usageKeys = Object.keys(series.usage);
    if (usageKeys.length > 0) {
      dtdd(dl, 'usage', usageKeys.map(function (k) { return k + ' ' + series.usage[k]; }).join(' · '));
    }
    box.appendChild(dl);
    if (series.seats.length > 0) {
      box.appendChild(buildTable(['bot', 'persona', 'model', 'provider'], series.seats.map(function (seat) {
        return [seat.bot, seat.persona, seat.model, seat.provider];
      })));
    }
    series.games.forEach(function (game) {
      var line = 'game ' + game.gameIndex + (game.gameId ? ' · ' + game.gameId : '') +
        (game.outcome.phase ? ' · ' + game.outcome.phase : '') +
        (game.outcome.winnerLabel ? ' · winner ' + game.outcome.winnerLabel : '') +
        (game.relayCount == null ? '' : ' · ' + game.relayCount + ' relay event(s)');
      box.appendChild(el('p', 'status-line', line));
    });
    series.errors.forEach(function (issue) {
      box.appendChild(el('p', 'status-line error', issue.name + ': ' + issue.message));
    });
    box.hidden = false;
    if (series.status === 'running') {
      seriesTimer = setTimeout(function () { if (state.artifactId === id) loadSeries(id); }, 3000);
    }
  }
`;
