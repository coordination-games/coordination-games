import { Command } from "commander";

export function registerServeCommand(program: Command) {
  program
    .command("serve")
    .description("Start MCP server for AI tool integration")
    .option("--stdio", "Use stdio transport (for Claude Code, Claude Desktop)")
    .option("--http [port]", "Use HTTP transport (for OpenAI, other HTTP MCP clients)")
    .action(async (opts) => {
      // Dynamic import to avoid loading MCP deps when not needed
      const { startMcpServer } = await import("../mcp-server.js");

      if (opts.http) {
        const port = typeof opts.http === "string" ? parseInt(opts.http, 10) : 3000;
        await startMcpServer("http", port);
      } else {
        // Default to stdio
        await startMcpServer("stdio");
      }
    });
}
