# Comedy Sweep Lane

This is the first reusable **Comedy of the Commons** sweep lane.

It is intentionally thin:

- reuse the real platform-aligned runner in `scripts/run-game.ts`
- lock the game type to `comedy-of-the-commons`
- vary a small matrix of persona/model presets
- emit structured run artifacts for later comparison

## Run a sweep

```bash
npx tsx scripts/run-comedy-sweep.ts
```

Run a specific case only:

```bash
npx tsx scripts/run-comedy-sweep.ts --case commons-steward
```

Preview the planned sweep without starting games:

```bash
npx tsx scripts/run-comedy-sweep.ts --dry-run
```

Artifacts are written under:

```bash
artifacts/comedy-sweeps/<timestamp>/
```

Each run appends one JSON line to `results.jsonl` and writes matching stdout/stderr logs.

## Why this exists

This slice is **Comedy-first** and deliberately avoids building a generic harness platform too early.

It gives us:

- repeatable Comedy runs
- simple persona/model comparisons
- machine-readable artifacts
- one bridge from local gameplay proof to later harness sweeps

## What it does not do yet

- no generic multi-game sweep framework
- no final benchmark/evaluation scoring
- no dependence on the OATHBREAKER local emulator path
- no requirement for the 85b bot-token path

It is a thin wrapper around the existing runner, not a new harness subsystem.
