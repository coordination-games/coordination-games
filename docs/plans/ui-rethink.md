# UI rethink — what shape this should actually be

Steer (Aaron, 2026-07-10): we adopted Lucian's and Djimo's shapes without asking if they're right. First make it work; then decide what it should really be.

## Honest read of what we have

We inherited two shapes and let both leak into the user's face:

- **From the harness (Lucian)** we inherited the *nouns*: campaign, spec, seats, globals, runs, manifest, maxModelCallsPerBot. Correct for the data layer; wrong as UI vocabulary. Nobody watching a demo cares about any of those words.
- **From the console (Djimo)** we inherited the *interaction*: a config form with every knob exposed. Right for his job (provider A/B plumbing); wrong as a product's primary surface.
- **What I added** followed both: researcher-shaped tabs, a raw terminal as the "live" view, my dark-terminal aesthetic. Legible to engineers, cold to everyone else.

Structural problems, in order of importance:

1. **The atomic unit is wrong.** The UI is organized around *runs* (infrastructure). It should be organized around *questions asked and answered* — a story with a beginning (the question), a middle (agents playing), and an end (the finding).
2. **The emotional core is exiled.** The most compelling thing we own — agents negotiating on a living hex board — lives on another port behind a "▶ watch replay" link. Watching should be the centerpiece of the experience, not an appendix.
3. **The live moment is the weakest moment.** During a run you see harness stdout. The actual drama — "I pledge to extract low", a betrayal, a pact holding — is in the relay, unrendered until the judge speaks afterward.
4. **No narrative spine.** Judge prose is good but post-hoc. Nothing narrates *now*.
5. **Internal vocabulary as copy** throughout ("consequential turns", "relay", "manifest").

What's right and must survive any redesign: disk-as-truth; console-wraps-CLI (One Rule); dig-in transparency (raw JSON always reachable); findings-verdict-first (closest page to correct); presets-encode-methodology.

## North star

**A science-museum exhibit, operable by a visitor, trusted by a researcher.**

One surface, three moments — not four tabs:

1. **Ask** — question cards (exists today, keep).
2. **Watch** — one page owning the whole run lifecycle: warming up → playing → judged. The game board embedded as the centerpiece (spectator components or iframe), beside it a narrated feed built from the relay (chat bubbles for agent messages, plain-language action lines, round markers), a commons-health meter ticking. InspectorPage's `buildEvents()` already does this transform — port it, don't reinvent it.
3. **Learn** — the findings card arrives in-place when the judge finishes: verdict, chart, download-the-report, and **"run it again with a twist"** (one-click variations: add a mediator, swap a model, disable trust). This is where configurability re-enters — as variations on a question, never as a blank form.

The Lab remains as the researcher's back door (today's pages, demoted in nav). Language pass everywhere: experiment/question/game/agents/conversation/trust. Aesthetic: let the console inherit the observatory's organic visual language (forests, commons) instead of terminal-noir.

## Reliability doctrine (the "make sure it works" half)

Today's failure was environment drift (launchd PATH ≠ shell PATH → `spawn claude ENOENT`; Node 25 escalating a latent handle race). The class, not the instance, needs killing:

- **Preflight self-test** at boot + before every demo: claude binary (shipped 2026-07-10), game server, cli dist present, runs/ writable, node version. Surface as a green/amber banner in the UI; a demo launch with a red preflight fails as one sentence.
- **Usage-limit surfacing**: the runner already detects "You've hit your session limit"; bubble it to the UI as "Claude's usage window is full — resets at HH:MM" instead of a generic failed job.
- **Demo dry-run ritual**: one command (`demo-check`) that exercises launch → play (1 short game) → judge → findings and reports pass/fail. Run it before any real demo; candidates for nightly.
- **Error taxonomy rule**: every failure the UI can show maps to a sentence + one action (retry / open settings / wait). Anything else is a bug by definition.

## Build phases

1. **Watch page** (biggest lever): embed spectator + narrated relay feed + lifecycle states on one page. Port `buildEvents()`. Kill the terminal-as-default (keep behind "details").
2. **Language + IA pass**: three-moment nav, rename everything user-facing, findings-card-in-flow, "run again with a twist" variations.
3. **Exhibit mode**: full-screen auto-advancing narration for events (the DevCon-room idea from the June meetings).
4. **Preflight banner + demo-check + limit surfacing** (parallel to any of the above).
