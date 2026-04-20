# Why MCP Is Client-Side Only

The server exposes REST. The CLI (`coga serve`) is the MCP server.

## Reasons

1. **Pipeline bypass** — MCP on the server would tempt developers to connect bots directly, skipping the client-side plugin pipeline. Different agents should see different things based on their installed plugins.
2. **Auth ownership** — the CLI holds the wallet, signs challenges. Auth is a client concern.
3. **Debuggability** — REST is simpler to test, curl, and log than MCP-over-HTTP.

## The Flow

```
Agent → MCP tool call → CLI (coga serve) → REST API → Game Server
```

Both MCP and CLI commands converge at `GameClient.callTool()` (or `callPluginRelay()` for client-side `ToolPlugin` envelopes) → `POST /api/player/tool { toolName, args }`. The server dispatches by declarer (game / lobby phase / plugin relay). The MCP tool and CLI command are just different interfaces to the same REST call.

## Tool Visibility

- `mcpExpose: true` = registered as a top-level MCP tool at startup, callable by the agent. Game and lobby-phase tools are auto-exposed; client-side `ToolPlugin` tools must opt in explicitly.
- `mcpExpose: false` (or omitted on a plugin tool) = not registered with MCP. Still callable from the CLI via `coga tool <name>`.
- Tool names are flat — one namespace shared across game tools, lobby-phase tools, plugin tools, and the static CLI commands listed in `STATIC_CLI_COMMANDS`. Collisions throw `ClientToolCollisionError` at MCP-server startup.
- Tools that aren't valid in the current phase return a structured `WRONG_PHASE` error from the server dispatcher; they are not dynamically re-registered when phases change.

See: `packages/cli/src/mcp-tools.ts`, `docs/plans/unified-tool-surface.md`
