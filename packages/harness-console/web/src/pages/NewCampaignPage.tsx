import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { ErrorNote, Field, Section } from '../components/ui';
import type { CampaignSpecDraft, ConsoleMeta, GameEntryDraft, SeatDraft } from '../types';

const CUSTOM_PREFIX = 'custom:';

interface CustomPersona {
  name: string;
  text: string;
}

/** Editable rows need identity that survives add/remove — uiKey never leaves the client. */
let uiSeq = 0;
const nextUiKey = () => `ui-${++uiSeq}`;

interface SeatUI extends SeatDraft {
  uiKey: string;
}

interface EntryUI extends Omit<GameEntryDraft, 'seats'> {
  uiKey: string;
  seats: SeatUI[];
}

function emptySeat(model = 'anthropic/claude-haiku'): SeatUI {
  return { uiKey: nextUiKey(), persona: 'peaceful-mediator', model, count: 2 };
}

function emptyEntry(game: string): EntryUI {
  return { uiKey: nextUiKey(), game, rounds: 4, params: { teamSize: 4 }, seats: [emptySeat()] };
}

export function NewCampaignPage() {
  const navigate = useNavigate();
  const [meta, setMeta] = useState<ConsoleMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [launching, setLaunching] = useState(false);

  const [server, setServer] = useState('http://localhost:8787');
  const [analysisEnabled, setAnalysisEnabled] = useState(true);
  const [analysisModel, setAnalysisModel] = useState('anthropic/claude-haiku');
  const [maxCalls, setMaxCalls] = useState(80);
  const [entries, setEntries] = useState<EntryUI[]>([]);
  const [customPersonas, setCustomPersonas] = useState<CustomPersona[]>([]);
  const [newPersona, setNewPersona] = useState<CustomPersona | null>(null);

  useEffect(() => {
    api
      .meta()
      .then((m) => {
        setMeta(m);
        setEntries([
          emptyEntry(
            m.games.includes('tragedy-of-the-commons')
              ? 'tragedy-of-the-commons'
              : (m.games[0] ?? ''),
          ),
        ]);
      })
      .catch((err: Error) => setError(err.message));
  }, []);

  const personaOptions = useMemo(() => {
    const bundled = (meta?.personas ?? []).map((p) => ({
      value: p.ref,
      label: `${p.name} (${p.source})`,
    }));
    const custom = customPersonas.map((p) => ({
      value: `${CUSTOM_PREFIX}${p.name}`,
      label: `${p.name} (new)`,
    }));
    return [...bundled, ...custom];
  }, [meta, customPersonas]);

  const modelOptions = useMemo(
    () => [...(meta?.modelSuggestions.claude ?? []), ...(meta?.modelSuggestions.openrouter ?? [])],
    [meta],
  );

  const totalSeats = entries.reduce(
    (acc, e) => acc + e.seats.reduce((a, s) => a + (s.count || 0), 0) * (e.repeats ?? 1),
    0,
  );
  const totalRuns = entries.reduce((acc, e) => acc + (e.repeats ?? 1), 0);

  function updateEntry(i: number, patch: Partial<EntryUI>) {
    setEntries((prev) => prev.map((e, j) => (j === i ? { ...e, ...patch } : e)));
  }

  function updateSeat(i: number, k: number, patch: Partial<SeatDraft>) {
    setEntries((prev) =>
      prev.map((e, j) =>
        j === i ? { ...e, seats: e.seats.map((s, l) => (l === k ? { ...s, ...patch } : s)) } : e,
      ),
    );
  }

  async function launch() {
    setLaunching(true);
    setError(null);
    try {
      const spec: CampaignSpecDraft = {
        globals: {
          server,
          identities: 'ephemeral',
          limits: { maxModelCallsPerBot: maxCalls, wallClockMsPerRun: 1_200_000 },
          ...(analysisEnabled ? { analysis: { enabled: true, model: analysisModel } } : {}),
        },
        games: entries.map(({ label, uiKey: _entryKey, ...e }) => ({
          ...e,
          // Empty label = unset (the harness derives one from the game slug).
          ...(label?.trim() ? { label: label.trim() } : {}),
          seats: e.seats.map(({ uiKey: _seatKey, ...s }) => ({
            ...s,
            // custom:<name> refs are resolved server-side to written bundles.
            persona: s.persona.startsWith(CUSTOM_PREFIX)
              ? s.persona.slice(CUSTOM_PREFIX.length)
              : s.persona,
          })),
        })),
      };
      const job = await api.launch(spec, customPersonas);
      navigate(`/job/${job.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setLaunching(false);
    }
  }

  if (!meta) return <ErrorNote error={error ?? null} />;

  return (
    <div>
      <ErrorNote error={error} />

      <Section title="campaign globals">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Field label="game server">
            <input className="input" value={server} onChange={(e) => setServer(e.target.value)} />
          </Field>
          <Field label="max model calls / bot">
            <input
              className="input"
              type="number"
              min={1}
              value={maxCalls}
              onChange={(e) => setMaxCalls(Number(e.target.value) || 80)}
            />
          </Field>
          <Field label="judge analysis">
            <select
              className="input"
              value={analysisEnabled ? 'on' : 'off'}
              onChange={(e) => setAnalysisEnabled(e.target.value === 'on')}
            >
              <option value="on">enabled</option>
              <option value="off">disabled</option>
            </select>
          </Field>
          <Field label="judge model">
            <input
              className="input"
              list="model-suggestions"
              value={analysisModel}
              disabled={!analysisEnabled}
              onChange={(e) => setAnalysisModel(e.target.value)}
            />
          </Field>
        </div>
      </Section>

      {entries.map((entry, i) => (
        <Section
          key={entry.uiKey}
          title={`game entry ${i + 1}`}
          right={
            entries.length > 1 ? (
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => setEntries((prev) => prev.filter((_, j) => j !== i))}
              >
                remove
              </button>
            ) : undefined
          }
        >
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
            <Field label="game">
              <select
                className="input"
                value={entry.game}
                onChange={(e) => updateEntry(i, { game: e.target.value })}
              >
                {meta.games.map((g) => (
                  <option key={g} value={g}>
                    {g}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="rounds">
              <input
                className="input"
                type="number"
                min={1}
                value={entry.rounds}
                onChange={(e) => updateEntry(i, { rounds: Number(e.target.value) || 1 })}
              />
            </Field>
            <Field label="team size">
              <input
                className="input"
                type="number"
                min={2}
                value={Number((entry.params as { teamSize?: number }).teamSize ?? 4)}
                onChange={(e) =>
                  updateEntry(i, {
                    params: { ...entry.params, teamSize: Number(e.target.value) || 4 },
                  })
                }
              />
            </Field>
            <Field label="repeats">
              <input
                className="input"
                type="number"
                min={1}
                value={entry.repeats ?? 1}
                onChange={(e) =>
                  updateEntry(i, { repeats: Math.max(1, Number(e.target.value) || 1) })
                }
              />
            </Field>
            <Field label="label (optional)">
              <input
                className="input"
                value={entry.label ?? ''}
                placeholder={entry.game}
                onChange={(e) => updateEntry(i, { label: e.target.value })}
              />
            </Field>
          </div>

          <div className="label mb-2">seats</div>
          {entry.seats.map((seat, k) => (
            <div
              key={seat.uiKey}
              className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-2 p-3 rounded"
              style={{ background: 'var(--panel-2)' }}
            >
              <Field label="persona">
                <select
                  className="input"
                  value={seat.persona}
                  onChange={(e) => updateSeat(i, k, { persona: e.target.value })}
                >
                  {personaOptions.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="model">
                <input
                  className="input"
                  list="model-suggestions"
                  value={seat.model}
                  onChange={(e) => updateSeat(i, k, { model: e.target.value })}
                />
              </Field>
              <Field label="count">
                <input
                  className="input"
                  type="number"
                  min={1}
                  value={seat.count}
                  onChange={(e) =>
                    updateSeat(i, k, { count: Math.max(1, Number(e.target.value) || 1) })
                  }
                />
              </Field>
              <div className="flex items-end">
                {entry.seats.length > 1 && (
                  <button
                    type="button"
                    className="btn btn-danger"
                    onClick={() => updateEntry(i, { seats: entry.seats.filter((_, l) => l !== k) })}
                  >
                    remove seat
                  </button>
                )}
              </div>
            </div>
          ))}
          <div className="flex gap-2 mt-2">
            <button
              type="button"
              className="btn"
              onClick={() =>
                updateEntry(i, {
                  seats: [...entry.seats, emptySeat('openrouter/minimax/minimax-m2')],
                })
              }
            >
              + seat group
            </button>
          </div>
        </Section>
      ))}

      <div className="flex gap-2 mb-4">
        <button
          type="button"
          className="btn"
          onClick={() => setEntries((prev) => [...prev, emptyEntry(meta.games[0] ?? '')])}
        >
          + game entry
        </button>
        <button type="button" className="btn" onClick={() => setNewPersona({ name: '', text: '' })}>
          + custom persona
        </button>
      </div>

      {newPersona && (
        <Section title="new persona">
          <div className="grid gap-3">
            <Field label="name">
              <input
                className="input"
                value={newPersona.name}
                onChange={(e) => setNewPersona({ ...newPersona, name: e.target.value })}
                placeholder="ruthless-negotiator"
              />
            </Field>
            <Field label="persona.md — behavior, voice, strategy (game-agnostic)">
              <textarea
                className="input font-mono"
                rows={8}
                value={newPersona.text}
                onChange={(e) => setNewPersona({ ...newPersona, text: e.target.value })}
                placeholder={
                  '# Ruthless Negotiator\n\nYou drive hard bargains but keep your word...'
                }
              />
            </Field>
            <div className="flex gap-2">
              <button
                type="button"
                className="btn btn-primary"
                disabled={!newPersona.name.trim() || !newPersona.text.trim()}
                onClick={() => {
                  setCustomPersonas((prev) => [...prev, newPersona]);
                  setNewPersona(null);
                }}
              >
                add persona
              </button>
              <button type="button" className="btn" onClick={() => setNewPersona(null)}>
                cancel
              </button>
            </div>
          </div>
        </Section>
      )}

      <datalist id="model-suggestions">
        {modelOptions.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>

      <div className="panel p-4 flex items-center justify-between">
        <div className="font-mono text-xs" style={{ color: 'var(--ink-dim)' }}>
          {totalRuns} run{totalRuns === 1 ? '' : 's'} · {totalSeats} seats total · sequential
          execution · results → runs/out/
        </div>
        <button
          type="button"
          className="btn btn-primary"
          disabled={launching || entries.length === 0}
          onClick={launch}
        >
          {launching ? 'launching…' : 'launch campaign'}
        </button>
      </div>
    </div>
  );
}
