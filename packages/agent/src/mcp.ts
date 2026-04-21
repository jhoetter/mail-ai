// MCP stdio server. Mirrors office-ai's mcp tool: third-party LLM
// clients (Claude Desktop, Continue, etc.) speak MCP and consume the
// tools we register here. Each tool wraps a CLI verb; the schemas come
// from src/schemas.ts so input validation is shared.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CommandPayloadSchema, ThreadQuerySchema, SearchSpecSchema } from "./schemas.js";

export async function startMcpStdio(): Promise<void> {
  const server = new Server(
    { name: "mail-agent", version: "0.0.0" },
    { capabilities: { tools: {} } },
  );

  // Tool: list threads
  server.setRequestHandler(
    {
      method: "tools/list",
      // The MCP SDK uses zod-derived JSON schemas; we hand-roll them
      // here so the CLI scaffold stays compilable without a full SDK
      // schema dependency tree.
      schema: undefined,
    } as never,
    async () => ({
      tools: [
        {
          name: "thread.list",
          description: "List threads matching a query (status / assignee / mailbox).",
          inputSchema: ThreadQuerySchema,
        },
        {
          name: "search",
          description: "Full-text search over the overlay DB.",
          inputSchema: SearchSpecSchema,
        },
        {
          name: "command.apply",
          description: "Apply a typed command via the command bus.",
          inputSchema: CommandPayloadSchema,
        },
      ],
    }),
  );

  await server.connect(new StdioServerTransport());
}
