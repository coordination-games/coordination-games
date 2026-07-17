# Instrument v2 — pressure calibration protocol

Rung 5 of `docs/plans/research-program.md`. Every prior Tragedy condition lands at
90–97% commons health regardless of disposition, model, or capability ablation — a
ceiling effect that makes rung 4 (trust visibility, the thesis experiment) unmeasurable.
This protocol calibrates the new `pressure` dial (`packages/games/tragedy-of-the-commons/src/game.ts`,
"Pressure dial" comment table above `V2_TILE_SPECS`) against the one condition we
already believe should fail: four win-focused-opportunist agents with no chat channel.

## What the dial does

`pressure` is a 0–3 scalar, default 0 (byte-identical to today's constants). Passed as
`params.pressure` in a harness spec, it flows through lobby-create → `LobbyDO`
`accumulatedMetadata` → `TragedyOfTheCommonsV2Plugin.createConfig` exactly like
`params.teamSize` and `params.rounds` already do — no new plumbing per spec. At each
step it scales starting tile health down, and extraction's private yield and commons
decay up (capacity — how many times a structure can extract per round — is untouched,
so higher pressure never makes the game unplayable). Full mapping table lives in
`game.ts`; the short version: pressure 3 cuts starting tile health to 40% and roughly
doubles both what a "high" extraction pays the extractor and what it costs the tile.

## Spec matrix

Two conditions crossed with three pressure levels, n=2 repeats each = 12 games:

| Condition | Seats | Chat | Purpose |
|---|---|---|---|
| **no-chat / all-opportunist** | 4× `win-focused-opportunist` | disabled (`disablePlugins: ['basic-chat']`) | The floor. No coordination signal, no mediator, pure private incentive. |
| **chat / mixed** | 2× `peaceful-mediator` + 2× `win-focused-opportunist` | enabled | The ceiling. Same rung-3 condition that held at ~92% under pressure 0. |

Run both conditions at pressure 1, 2, and 3 (pressure 0 is already characterized —
that's the ceiling-effect finding itself, no need to re-run it here). 6 arms × 2
repeats = 12 games.

## Success criterion

At **some** pressure level p ∈ {1, 2, 3}:

```
avg(commonsHealthPercent | no-chat/all-opportunist, pressure=p)
  <=
avg(commonsHealthPercent | chat/mixed, pressure=p) − 25
```

i.e. the opportunist/no-chat floor sits at least 25 points below the chat/mixed
ceiling at the same pressure. If no level clears this, pressure isn't the right axis
(or 0–3 doesn't go far enough) and the next move is widening the range or adding a
second axis (e.g. `maxRounds`) rather than re-running this same sweep. If **multiple**
levels clear it, pick the lowest p that does — the least-distorted dilemma that still
has dynamic range is the better instrument for rung 4 (trust visibility), since it
stays closest to the calibrated-but-not-yet-broken baseline the rest of the ladder used.

n=2/arm is a calibration probe, not a publishable result — it's enough to tell whether
the dial has bite, not enough to report a number. Once a pressure level clears the
criterion, rung 4 should re-run at that level with the harness's normal n (≥3/arm).

## Campaign spec

Save as `runs/pressure-calibration.yaml` (the harness's YAML loader accepts pure JSON
— it's valid YAML — so this can be pasted as-is):

```json
{
  "globals": {
    "server": "http://localhost:8787",
    "identities": "ephemeral",
    "output": "./runs/out",
    "limits": { "maxModelCallsPerBot": 120, "wallClockMsPerRun": 900000 },
    "analysis": { "enabled": true, "model": "haiku" }
  },
  "games": [
    {
      "label": "p1-no-chat-4opp",
      "game": "tragedy-of-the-commons",
      "rounds": 6,
      "params": { "teamSize": 4, "pressure": 1 },
      "disablePlugins": ["basic-chat"],
      "repeats": 2,
      "seats": [
        { "persona": "./personas/win-focused-opportunist", "model": "haiku", "count": 4 }
      ]
    },
    {
      "label": "p1-chat-2m2o",
      "game": "tragedy-of-the-commons",
      "rounds": 6,
      "params": { "teamSize": 4, "pressure": 1 },
      "repeats": 2,
      "seats": [
        { "persona": "./personas/peaceful-mediator", "model": "haiku", "count": 2 },
        { "persona": "./personas/win-focused-opportunist", "model": "haiku", "count": 2 }
      ]
    },
    {
      "label": "p2-no-chat-4opp",
      "game": "tragedy-of-the-commons",
      "rounds": 6,
      "params": { "teamSize": 4, "pressure": 2 },
      "disablePlugins": ["basic-chat"],
      "repeats": 2,
      "seats": [
        { "persona": "./personas/win-focused-opportunist", "model": "haiku", "count": 4 }
      ]
    },
    {
      "label": "p2-chat-2m2o",
      "game": "tragedy-of-the-commons",
      "rounds": 6,
      "params": { "teamSize": 4, "pressure": 2 },
      "repeats": 2,
      "seats": [
        { "persona": "./personas/peaceful-mediator", "model": "haiku", "count": 2 },
        { "persona": "./personas/win-focused-opportunist", "model": "haiku", "count": 2 }
      ]
    },
    {
      "label": "p3-no-chat-4opp",
      "game": "tragedy-of-the-commons",
      "rounds": 6,
      "params": { "teamSize": 4, "pressure": 3 },
      "disablePlugins": ["basic-chat"],
      "repeats": 2,
      "seats": [
        { "persona": "./personas/win-focused-opportunist", "model": "haiku", "count": 4 }
      ]
    },
    {
      "label": "p3-chat-2m2o",
      "game": "tragedy-of-the-commons",
      "rounds": 6,
      "params": { "teamSize": 4, "pressure": 3 },
      "repeats": 2,
      "seats": [
        { "persona": "./personas/peaceful-mediator", "model": "haiku", "count": 2 },
        { "persona": "./personas/win-focused-opportunist", "model": "haiku", "count": 2 }
      ]
    }
  ]
}
```

Run with:

```bash
npx tsx packages/model-harness/src/index.ts run --dry-run runs/pressure-calibration.yaml   # sanity check seat plan first
npx tsx packages/model-harness/src/index.ts run runs/pressure-calibration.yaml
```

`rounds: 6` is a starting guess, not load-bearing — at pressure 2–3 a tile can collapse
in one or two extractions (see `packages/games/tragedy-of-the-commons/src/__tests__/pressure.test.ts`
for a worked single-extraction example), so the dynamics that matter likely resolve
well before round 6. If the no-chat arms finish early with commons already pinned at
the floor, shortening `rounds` for the next sweep is fine — the criterion cares about
the endpoint, not the path.

## Reading the results

Per arm, average `commonsHealthPercent` from `getOutcome`/the judge report across the
2 repeats (`runs/out/campaign-<id>/campaign.json` indexes each run's `manifest.json`).
Compare the six per-pressure-level (no-chat vs chat) pairs against the criterion above.
Note the incident/betrayal/pledge counters too (rung 1–3 found zero across every prior
condition) — a pressure level that finally produces incidents, not just a lower number,
is worth flagging separately since it would be the first behavioral (not just outcome)
signal the ladder has seen.

## Note on scope

This is the calibration probe only. Running it, running the campaigns it specifies,
and running the eventual rung-4 (trust visibility) experiment are explicitly **not**
part of the build task that produced this document — the orchestrator runs the sweep.
