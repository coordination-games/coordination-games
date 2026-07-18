/**
 * Console client fragment: canonical spec summary rendering, including the
 * resolved non-secret sampling/reliability settings per profile-backed seat.
 * Everything here builds DOM nodes via createElement/textContent ONLY. Runs
 * inside the core fragment's IIFE scope ($, state, getJson, setStatus, el,
 * dtdd, buildTable).
 */

export const CLIENT_SUMMARY_JS = `
  // ── Spec summary (canonical parser truth) ────────────────────────────────
  function loadSummary(specId) {
    var box = $('spec-summary');
    box.hidden = true;
    getJson('/api/specs/summary?id=' + encodeURIComponent(specId)).then(function (s) {
      if (state.specId === specId) renderSummary(box, s);
    }).catch(function (err) { setStatus('specs-status', String(err.message || err), true); });
  }
  function renderSummary(box, s) {
    box.textContent = '';
    if (!s.ok) {
      box.appendChild(el('div', 'subhead', 'spec problems'));
      box.appendChild(el('p', 'status-line error',
        s.failure.kind + ': ' + s.failure.message + (s.failure.truncated ? ' … [truncated]' : '')));
      box.hidden = false;
      return;
    }
    var dl = el('dl', 'audit', null);
    dtdd(dl, 'identities', s.identities);
    dtdd(dl, 'model calls / bot', s.limits.maxModelCallsPerBot);
    dtdd(dl, 'wall clock / run', s.limits.wallClockMsPerRun + ' ms');
    if (s.limits.maxAggregateCostMicrousd != null) {
      dtdd(dl, 'budget cap', s.limits.maxAggregateCostMicrousd + ' µUSD');
    }
    dtdd(dl, 'entries', s.totals.entries + ' entry(ies), ' + s.totals.totalRuns + ' run(s)');
    dtdd(dl, 'max model sessions', s.totals.maxModelSessions);
    box.appendChild(dl);
    s.entries.forEach(function (entry) { box.appendChild(renderSummaryEntry(entry)); });
    box.hidden = false;
  }
  function renderSummaryEntry(entry) {
    var wrap = el('div', null, null);
    var head = el('div', 'subhead', null);
    head.appendChild(el('span', null, entry.label + ' · ' + entry.game + ' '));
    if (entry.kind === 'tournament') head.appendChild(el('span', 'badge tournament', 'tournament'));
    wrap.appendChild(head);
    var dl = el('dl', 'audit', null);
    dtdd(dl, 'rounds', entry.rounds + (entry.tournament ? ' (policy.maxRounds)' : ''));
    dtdd(dl, 'repeats', entry.repeats);
    dtdd(dl, 'max model sessions', entry.maxModelSessions);
    if (entry.tournament) {
      var p = entry.tournament.policy;
      dtdd(dl, 'series games', p.seriesLength);
      dtdd(dl, 'hidden rounds', p.minRounds + '-' + p.maxRounds + ' · hazard ' + p.hazardNumerator + '/' + p.hazardDenominator);
      dtdd(dl, 'economics', 'entry ' + p.baseEntryCost + ' · carry ' + p.carryBps + ' bps · slash ' + p.slashBps + ' bps');
    }
    wrap.appendChild(dl);
    wrap.appendChild(buildTable(['persona', 'count', 'provider', 'model', 'profile'], entry.seats.map(function (seat) {
      return [seat.persona, seat.count, seat.provider, seat.model, seat.profile];
    })));
    var tuned = entry.seats.filter(function (seat) { return seat.settings != null; });
    if (tuned.length > 0) {
      wrap.appendChild(el('div', 'subhead', 'model settings'));
      var sdl = el('dl', 'audit', null);
      tuned.forEach(function (seat) {
        dtdd(sdl, seat.persona + (seat.profile ? ' (' + seat.profile + ')' : ''), settingsText(seat.settings));
      });
      wrap.appendChild(sdl);
    }
    return wrap;
  }
  function settingsText(s) {
    var parts = [];
    if (s.temperature != null) parts.push('temp ' + s.temperature);
    if (s.topP != null) parts.push('topP ' + s.topP);
    if (s.maxCompletionTokens != null) parts.push('maxTokens ' + s.maxCompletionTokens);
    if (s.reasoningSplit != null) parts.push('reasoningSplit ' + s.reasoningSplit);
    if (s.reasoningEffort != null) parts.push('effort ' + s.reasoningEffort);
    if (s.timeoutMs != null) parts.push('timeout ' + s.timeoutMs + ' ms');
    if (s.retries != null) parts.push('retries ' + s.retries);
    return parts.length > 0 ? parts.join(' · ') : '(profile defaults)';
  }
`;
