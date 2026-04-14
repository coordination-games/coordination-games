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

Both MCP and CLI commands converge at `GameClient.callPluginTool()` → `POST /api/player/tool`. The MCP tool and CLI command are just different interfaces to the same REST call.

## Tool Visibility

- `mcpExpose: true` = agent sees it as MCP tool during gameplay (mid-turn actions like chat)
- `mcpExpose: false` = CLI only via `coga tool <pluginId> <toolName>` (between-game setup)
- MCP tool names are unnamespaced (`chat`). CLI tools are namespaced (`coga tool basic-chat chat`).
- Name collisions between plugins error at init time.

See: `ARCHITECTURE.md` "MCP vs CLI" section
