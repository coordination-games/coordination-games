/**
 * Canned demonstrations — the front door (docs/plans/demo-first.md, "layer
 * 1"). Each demo is a fixed, zero-configuration campaign spec that goes
 * through the exact same POST /api/campaigns path a hand-built campaign
 * takes (see prepareLaunch in server.ts): no new orchestration, just three
 * pre-filled shortcuts past the spec builder.
 */

/** Where the canned demos point the harness — matches the console's own
 * game-server default (see GET /api/server/status). */
export const DEMO_GAME_SERVER = 'http://localhost:8787';

const HAIKU = 'anthropic/claude-haiku';
const SONNET5 = 'anthropic/claude-sonnet-5';
const TRAGEDY = 'tragedy-of-the-commons';

interface DemoSeat {
  persona: string;
  model: string;
  count: number;
}

function seat(persona: string, model: string, count: number): DemoSeat {
  return { persona, model, count };
}

interface DemoGameEntry {
  game: string;
  rounds: number;
  params: Record<string, unknown>;
  label: string;
  repeats: number;
  seats: DemoSeat[];
}

function entry(label: string, repeats: number, seats: DemoSeat[]): DemoGameEntry {
  return { game: TRAGEDY, rounds: 3, params: { teamSize: 4 }, label, repeats, seats };
}

function spec(games: DemoGameEntry[], concurrency = 1): Record<string, unknown> {
  return {
    globals: {
      server: DEMO_GAME_SERVER,
      identities: 'ephemeral',
      limits: { maxModelCallsPerBot: 100, wallClockMsPerRun: 1_500_000 },
      analysis: { enabled: true, model: HAIKU },
      // A demo audience should not wait for sequential games — overlap them.
      concurrency,
    },
    games,
  };
}

export interface Demo {
  id: string;
  title: string;
  question: string;
  blurb: string;
  estMinutes: number;
  spec: Record<string, unknown>;
}

export const DEMOS: Demo[] = [
  {
    id: 'commons',
    title: 'Share a Commons',
    question: 'Can AI agents share a commons?',
    blurb:
      'Four agents draw from one shared resource for three rounds. Watch whether they pace ' +
      'themselves or race each other to extract first.',
    estMinutes: 5,
    spec: spec([
      entry('quick-game', 1, [
        seat('peaceful-mediator', HAIKU, 2),
        seat('win-focused-opportunist', HAIKU, 2),
      ]),
    ]),
  },
  {
    id: 'model-faceoff',
    title: 'Model Face-off',
    question: 'Which AI cooperates better?',
    blurb:
      'The same two personas play three games on Claude Haiku and three on Claude Sonnet 5, so ' +
      'you can see how the model itself changes what agents do.',
    estMinutes: 8,
    spec: spec(
      [
        entry('haiku-vs-sonnet5', 3, [
          seat('peaceful-mediator', HAIKU, 1),
          seat('win-focused-opportunist', HAIKU, 1),
          seat('peaceful-mediator', SONNET5, 1),
          seat('win-focused-opportunist', SONNET5, 1),
        ]),
      ],
      3,
    ),
  },
  {
    id: 'peacemaker',
    title: 'The Peacemaker Effect',
    question: 'Does a peacemaker change everything?',
    blurb:
      'A table of four opportunists against a table of four peacemakers, two runs each — see ' +
      'whether disposition alone can save, or doom, the commons.',
    estMinutes: 8,
    spec: spec(
      [
        entry('med0', 2, [seat('win-focused-opportunist', HAIKU, 4)]),
        entry('med4', 2, [seat('peaceful-mediator', HAIKU, 4)]),
      ],
      2,
    ),
  },
];
