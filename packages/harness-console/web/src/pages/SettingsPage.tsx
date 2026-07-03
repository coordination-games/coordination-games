import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { ErrorNote, Field, Section, StatusPill } from '../components/ui';
import type { GameServerStatus, SecretStatus } from '../types';

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
