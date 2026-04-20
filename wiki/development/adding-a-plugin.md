# Adding a Plugin

Reference implementation: `packages/plugins/basic-chat/`. The code
examples below use a hypothetical `kibitzer` plugin (a spectator-only
commentary overlay) as a pedagogical template — it exercises both relay
read and write plus its own envelope type, which basic-chat doesn't.
If you read one section, read **Gaps**.

## What "plugin" means here

Two halves under one id:

- **`ServerPlugin`** — runs in the workers-server. Per-DO instance for
  game-scoped plugins (settlement, basic-chat); worker-level singleton
  for cross-game plugins (ELO).
- **`WebToolPlugin`** — React component(s) registered into named slots
  (`lobby:card`, `lobby:panel`, `game:panel`, `game:overlay`).

Most plugins want both halves. Some want only one (e.g. a server-only
data plugin with no UI; a chrome-only widget that only reads payload).

## Files you must create per plugin

Live reference: `packages/plugins/basic-chat/`. Minimum file set:

```
packages/plugins/<id>/
├── package.json              # workspace pkg, subpath exports for ./server + ./web
├── tsconfig.json             # extends ../../../tsconfig.base.json, jsx: react-jsx
└── src/
    ├── index.ts              # relay-type constant + Zod schema + self-registration
    ├── server.ts             # createXServerPlugin() builder
    ├── web/
    │   ├── index.tsx         # WebToolPlugin shape + slot wiring
    │   └── <Component>.tsx   # React component(s) per slot
    └── __tests__/
        └── <id>.test.ts      # at least one test
```

### `package.json` essentials

- Name: `@coordination-games/plugin-<id>`.
- `"exports"`: subpath exports for `.`, `./server`, `./web` so non-React
  consumers (workers-server, CLI) don't pull in React types via the
  umbrella import.
- `"peerDependencies": { "react": "^18.3.0" }` with
  `peerDependenciesMeta.react.optional = true` if `./web` is included.
- `"dependencies": { "@coordination-games/engine": "*", "zod": "^4.3.6" }`.

### `tsconfig.json`

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "composite": true,
    "jsx": "react-jsx",
    "lib": ["ES2022", "DOM"]
  },
  "include": ["src"],
  "exclude": ["src/__tests__"]
}
```

`composite: true` is required — every workspace package the build script
references (root `npm run build`) is tsc-`-b`-built. `lib: ["ES2022",
"DOM"]` is needed for any React JSX file (omit DOM and `React.FC` errors).

### `src/index.ts` — schema + self-registration

Export the relay envelope `type` constant and a Zod schema. Self-register
the schema at import time so any consumer that imports the plugin gets
schema validation in `DOStorageRelayClient.publish`:

```ts
export const KIBITZER_COMMENT_TYPE = 'kibitzer:comment';
export const KibitzerCommentSchema = z.object({ ... }).strict();

registerPluginRelayTypes({
  id: KIBITZER_PLUGIN_ID,
  relayTypes: { [KIBITZER_COMMENT_TYPE]: KibitzerCommentSchema },
});
```

### `src/server.ts` — `ServerPlugin` builder

Mirror the `ServerPlugin<R>` shape from
`packages/workers-server/src/plugins/runtime.ts` *structurally*, without
importing it — that direction would force every plugin package to take
on the workers-server (Cloudflare types) dependency.

```ts
export interface KibitzerServerPluginShape {
  id: string;
  requires: readonly ['relay'];
  init(caps: KibitzerCaps, game: KibitzerGameContext): Promise<void>;
  handleRelay(env: RelayEnvelope): Promise<RelayEnvelope[] | undefined>;
  handleCall(name: string, args: unknown): Promise<unknown>;
  dispose(): Promise<void>;
}

export function createKibitzerServerPlugin(opts): KibitzerServerPluginShape {
  let relay: KibitzerRelayCap | null = null;
  return {
    id: 'kibitzer',
    requires: ['relay'] as const,
    async init(caps) { relay = caps.relay; },
    async handleRelay(env) { /* react to envelopes */ },
    async handleCall(name, args) { /* tool surface */ },
    async dispose() { relay = null; },
  };
}
```

The capability subset (`KibitzerCaps`) is your contract: declare exactly
what you need. Capabilities you don't declare are not on the object the
runtime hands you — that's the safety the runtime provides.

### `src/web/index.tsx` — `WebToolPlugin`

Mirror the shape from `packages/web/src/plugins/types.ts#WebToolPlugin`
locally (don't import — would invert dependencies).

```ts
export const KibitzerWebPlugin: KibitzerWebPluginShape = {
  id: 'kibitzer',
  slots: { 'game:overlay': CommentaryFeed },
};
```

## Where to register it

Two registry sites today:

1. **Server**: `packages/workers-server/src/do/GameRoomDO.ts` →
   `getPluginRuntime()`, chain another `.then(() => runtime.register(
   createMyPlugin()))`. Per-DO plugins (anything that touches `relay` /
   `storage` / `alarms` / `chain`) live here.

   For cross-game plugins (ELO is the only one today): worker scope
   instead, in `packages/workers-server/src/plugin-endpoint.ts` →
   `getWorkerPluginRuntime()`.

2. **Web**: `packages/web/src/main.tsx` → one
   `registerWebPlugin(MyWebPlugin)` line.

3. **Workspace deps**: `packages/web/package.json` and
   `packages/workers-server/package.json` get
   `"@coordination-games/plugin-<id>": "*"`. Root `package.json` build
   script gets `-w packages/plugins/<id>`.

That's the irreducible set for a plugin needing both server and web
surfaces.

## Gaps (real abstraction shortfalls — Phase 5.4 surfaced these)

1. **Plugin runtime doesn't fan envelopes to `handleRelay`.**
   `ServerPluginRuntime.handleRelay` exists (it's tested in
   `plugin-runtime.test.ts`) but no DO calls it. Phase 5.4 wired
   GameRoomDO to call it after every chat publish via a private
   `fanRelayToPlugins()` helper. If a future plugin needs to react to
   relay traffic, the wiring is now there for game DOs but **not
   LobbyDO**. That second wiring is a follow-up.

2. **No worker-level relay capability.** Plugins that need to publish
   relay envelopes can only register in DOs (per-game). Cross-game
   reactive plugins (e.g. a global trust-graph that watches all chats)
   have no home today — the worker-scope runtime stubs `relay` to
   throw.

3. **WebToolPlugin slot props are mutable arrays.** `relayMessages` is
   `RelayMessageView[]` (mutable). A plugin that wants `readonly` on its
   own component signature gets a TS variance error when assigning into
   the host's `WebToolPlugin` shape. Workaround: use the same mutable
   array in your own props. Long-term: the host should declare
   `ReadonlyArray<RelayMessageView>`.

4. **Settlement runtime takes the alarm slot.** Per-DO
   `ServerPluginRuntime` is constructed with a `NamespacedStorage` keyed
   on `SETTLEMENT_PLUGIN_ID` only — every plugin in that runtime shares
   the settlement-namespace storage view. If a future plugin needs its
   own storage namespace, the runtime needs to hand each plugin a
   `NamespacedStorage(storage, plugin.id)` rather than reusing one.

5. **Kibitzer's web file CAN live colocated, but basic-chat's still
   doesn't.** `packages/web/src/plugins/chat-plugin.tsx` predates the
   pattern. Migrating it would also remove the workspace's only
   inverted dependency (web → plugin-chat is fine; plugin-chat → web
   types would be a dep cycle).

6. **`fanRelayToPlugins` synthesizes index/timestamp.** The real
   index/timestamp are assigned inside `DOStorageRelayClient.publish`
   and not returned. The synthesized envelope is good enough for
   reactive plugins that key off `type` / `data` / `scope`, but a
   plugin that wants the canonical index has to read the relay back.
   `RelayClient.publish` could return `Promise<RelayEnvelope>` instead
   of `Promise<void>` — clean follow-up.

7. **Self-registration via import side effect ordering.** Plugin schemas
   register at module import time. The import order in DO files matters
   only because `validateRelayBody` looks up by `type` at publish time
   — if the relay-registry isn't populated yet, publishes throw
   `RelayUnknownTypeError`. The current pattern (DOs import every
   plugin at module top, side-effects fire) works as long as no plugin
   tries to publish during another plugin's `init`.

## Capabilities and what they unlock

| Cap         | Scope     | What it unlocks                                                 |
|-------------|-----------|-----------------------------------------------------------------|
| `storage`   | per-DO    | Plugin-private kv (auto-namespaced under `plugin:<id>:`).       |
| `relay`     | per-DO    | Publish envelopes; read full visible relay for any viewer kind. |
| `alarms`    | per-DO    | Schedule `kind`-tagged alarms; runtime routes back to plugin.   |
| `d1`        | both      | Direct D1 access. Worker-scope plugins use this for tables.     |
| `chain`     | per-DO    | On-chain submit + receipt poll (settlement only today).         |

The runtime hands you `Pick<Capabilities, R>` based on your `requires`
declaration. Anything you don't declare isn't on the object — capability
isolation is a real type-level guarantee, not a documentation rule.

## Verifying plug-and-play

After wiring, run the Phase 5.4 acceptance check:

```bash
git status --short | grep -v "^.. packages/plugins/<id>/"
```

Expected: web `main.tsx`, GameRoomDO (or `plugin-endpoint.ts`), and the
two consumer `package.json` deps + root build script. ≤ 5 files outside
the plugin package is the realistic floor today.

For tests:

```bash
npx vitest run --root packages/plugins/<id>
npx vitest run --root packages/workers-server   # regression
npx vitest run --root packages/web              # regression
npm run check                                   # biome
```

Manual smoke: `wrangler dev` + create a lobby, send a few chat
messages, watch your plugin react in the spectator overlay or the
WS payload.
