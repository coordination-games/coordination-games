import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { ErrorNote, Field, Section, StatusPill } from '../components/ui';
import type { GameServerStatus, PreflightCheck, PreflightReport, SecretStatus } from '../types';

const SPECTATOR_URL = 'http://127.0.0.1:4173';

/** ok → mint, warn-but-failing → amber, fail → hot — all colors StatusPill
 * already knows via its 'ok' / 'incomplete' / 'error' status vocabulary. */
function checkPillStatus(c: PreflightCheck): string {
  if (c.ok) return 'ok';
  return c.severity === 'fail' ? 'error' : 'incomplete';
}

/** Full preflight checklist, with a manual re-check — the researcher's
 * "is this thing actually going to work" panel, first thing on the page. */
function HealthSection() {
  const [report, setReport] = useState<PreflightReport | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setChecking(true);
    api
      .preflight()
      .then((r) => {
        setReport(r);
        setError(null);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setChecking(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <Section
      title="console health"
      right={
        <button type="button" className="btn" onClick={refresh} disabled={checking}>
          {checking ? 're-checking…' : 're-check'}
        </button>
      }
    >
      <ErrorNote error={error} />
      {!report ? (
        <span className="label">checking…</span>
      ) : (
        <div className="flex flex-col gap-3">
          {report.checks.map((c) => (
            <div key={c.id} className="flex items-start gap-3">
              <StatusPill status={checkPillStatus(c)} />
              <div>
                <div className="font-mono text-xs" style={{ color: 'var(--ink)' }}>
                  {c.label}
                </div>
                {c.detail && (
                  <div className="text-xs mt-0.5" style={{ color: 'var(--ink-dim)' }}>
                    {c.detail}
                  </div>
                )}
              </div>
            </div>
          ))}
          <div className="label">node {report.nodeVersion}</div>
        </div>
      )}
    </Section>
  );
}

/**
 * Status-only card for the spectator UI (packages/web, served separately via
 * `vite preview`). No process management here — RunPage links assume it's
 * already up; this just tells you whether it is.
 */
function SpectatorStatus() {
  const [reachable, setReachable] = useState<boolean | null>(null);

  const check = useCallback(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    fetch(SPECTATOR_URL, { signal: controller.signal, mode: 'no-cors' })
      .then(() => setReachable(true))
      .catch(() => setReachable(false))
      .finally(() => clearTimeout(timer));
  }, []);

  useEffect(() => {
    check();
    const timer = setInterval(check, 5000);
    return () => clearInterval(timer);
  }, [check]);

  return (
    <Section title="spectator">
      <div className="flex items-center gap-3 mb-2">
        {reachable === null ? (
          <span className="label">checking…</span>
        ) : (
          <StatusPill status={reachable ? 'ok' : 'error'} />
        )}
        <span className="font-mono text-xs" style={{ color: 'var(--ink-dim)' }}>
          {reachable ? `${SPECTATOR_URL} is serving` : `not reachable at ${SPECTATOR_URL}`}
        </span>
      </div>
      <p className="label">cd packages/web && npm run build:local && npm run preview</p>
      <p className="label mt-1">
        build:local (not build) — packages/web/.env.production pins the prod API URL, which would
        otherwise override the local game server
      </p>
    </Section>
  );
}

export function SettingsPage() {
  const [secrets, setSecrets] = useState<SecretStatus | null>(null);
  const [openrouterKey, setOpenrouterKey] = useState('');
  const [inspectorToken, setInspectorToken] = useState('');
  const [claudeToken, setClaudeToken] = useState('');
  const [target, setTarget] = useState('http://localhost:8787');
  const [server, setServer] = useState<GameServerStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .secrets()
      .then(setSecrets)
      .catch((err: Error) => setError(err.message));
  }, []);

  const refreshServer = useCallback(() => {
    api
      .serverStatus(target)
      .then((s) => {
        setServer(s);
        setError(null);
      })
      .catch((err: Error) => setError(err.message));
  }, [target]);

  useEffect(() => {
    refreshServer();
    const timer = setInterval(refreshServer, 3000);
    return () => clearInterval(timer);
  }, [refreshServer]);

  return (
    <div>
      <HealthSection />

      <ErrorNote error={error} />

      <Section title="game server">
        <div className="flex items-end gap-3 flex-wrap mb-3">
          <Field label="target">
            <input
              className="input w-72"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
            />
          </Field>
          {server && <StatusPill status={server.reachable ? 'ok' : 'error'} />}
          <span className="font-mono text-xs" style={{ color: 'var(--ink-dim)' }}>
            {server?.reachable ? 'reachable' : 'not reachable'}
            {server?.readyUrl ? ` · ready on ${server.readyUrl}` : ''}
          </span>
          {!server?.managed ? (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => api.serverStart().then(refreshServer)}
            >
              start local server
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => api.serverStop().then(refreshServer)}
            >
              stop managed server
            </button>
          )}
        </div>
        {server && server.logs.length > 0 && (
          <pre className="terminal max-h-64">{server.logs.join('\n')}</pre>
        )}
      </Section>

      <SpectatorStatus />

      <Section title="secrets — stored in ~/.coordination/console-secrets.json (0600), passed to runs as env only">
        <div className="grid md:grid-cols-3 gap-6">
          <div>
            <Field label={`claude setup token ${secrets?.claude ? '· saved ✓' : '· not set'}`}>
              <input
                className="input"
                type="password"
                value={claudeToken}
                placeholder="sk-ant-oat…"
                onChange={(e) => setClaudeToken(e.target.value)}
              />
            </Field>
            <div className="flex gap-2 mt-2">
              <button
                type="button"
                className="btn btn-primary"
                disabled={!claudeToken}
                onClick={() =>
                  api.setSecret('claude', claudeToken).then((s) => {
                    setSecrets(s);
                    setClaudeToken('');
                  })
                }
              >
                save
              </button>
              {secrets?.claude && (
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={() => api.deleteSecret('claude').then(setSecrets)}
                >
                  clear
                </button>
              )}
            </div>
            <p className="label mt-2">
              from `claude setup-token` — runs claude seats on your subscription; without it, the
              machine's ~/.claude login is used
            </p>
          </div>
          <div>
            <Field label={`openrouter api key ${secrets?.openrouter ? '· saved ✓' : '· not set'}`}>
              <input
                className="input"
                type="password"
                value={openrouterKey}
                placeholder="sk-or-…"
                onChange={(e) => setOpenrouterKey(e.target.value)}
              />
            </Field>
            <div className="flex gap-2 mt-2">
              <button
                type="button"
                className="btn btn-primary"
                disabled={!openrouterKey}
                onClick={() =>
                  api.setSecret('openrouter', openrouterKey).then((s) => {
                    setSecrets(s);
                    setOpenrouterKey('');
                  })
                }
              >
                save
              </button>
              {secrets?.openrouter && (
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={() => api.deleteSecret('openrouter').then(setSecrets)}
                >
                  clear
                </button>
              )}
            </div>
            <p className="label mt-2">needed for any openrouter-backed seat</p>
          </div>
          <div>
            <Field
              label={`inspector token ${secrets?.inspector ? '· saved ✓' : '· default (local dev)'}`}
            >
              <input
                className="input"
                type="password"
                value={inspectorToken}
                placeholder="local-inspector-token"
                onChange={(e) => setInspectorToken(e.target.value)}
              />
            </Field>
            <div className="flex gap-2 mt-2">
              <button
                type="button"
                className="btn btn-primary"
                disabled={!inspectorToken}
                onClick={() =>
                  api.setSecret('inspector', inspectorToken).then((s) => {
                    setSecrets(s);
                    setInspectorToken('');
                  })
                }
              >
                save
              </button>
              {secrets?.inspector && (
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={() => api.deleteSecret('inspector').then(setSecrets)}
                >
                  clear
                </button>
              )}
            </div>
            <p className="label mt-2">
              admin-inspect token; defaults to the local dev value (matches workers-server
              .dev.vars)
            </p>
          </div>
        </div>
        <p className="label mt-4">
          claude seats run on a Claude subscription (setup token, or this machine's ~/.claude login)
          — no per-token API billing
        </p>
      </Section>
    </div>
  );
}
