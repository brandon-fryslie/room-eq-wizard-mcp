#!/usr/bin/env node
// Entry point: wire the shared RewClient and the tool registry to stdio.
// Configuration crosses the boundary once, here, from the environment.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { RewClient } from "./rew/client.js";
import { allTools, registerTools } from "./tools/index.js";

async function main(): Promise<void> {
  const client = new RewClient({ baseUrl: process.env.REW_API_URL });
  const server = new McpServer({ name: "room-eq-wizard-mcp", version: "0.1.0" });
  registerTools(server, client, allTools);
  await server.connect(new StdioServerTransport());
  // stdout is the MCP transport; stderr is the only legal log channel here.
  console.error(`room-eq-wizard-mcp: ${allTools.length} tools, REW API at ${client.baseUrl}`);
}

main().catch((error: unknown) => {
  console.error("room-eq-wizard-mcp failed to start:", error);
  process.exit(1);
});
