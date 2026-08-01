// [LAW:one-type-per-behavior] Every MCP tool is one instance of ToolDef: a name,
// a description, a Zod input shape, and a handler taking the shared RewClient.
// Adding a tool means adding a data entry — the registration loop never changes.

import { z } from "zod";
import { RewApiError, type RewClient } from "../rew/client.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: z.ZodRawShape;
  handler: (client: RewClient, args: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Typed constructor for a ToolDef: the handler sees args parsed to the shape's
 * output type. The cast to the untyped handler is the one seam where the
 * per-tool generic meets the homogeneous registry list.
 */
export function defineTool<Shape extends z.ZodRawShape>(def: {
  name: string;
  description: string;
  inputSchema: Shape;
  handler: (client: RewClient, args: z.output<z.ZodObject<Shape>>) => Promise<unknown>;
}): ToolDef {
  return def as unknown as ToolDef;
}

/** Shared parameter: REW addresses measurements by UUID (stable) or 1-based index (shifts). */
export const measurementIdInput = z
  .string()
  .describe("Measurement UUID (preferred — stable) or 1-based index (shifts when measurements are added/removed)");

export function registerTools(server: McpServer, client: RewClient, tools: ToolDef[]): void {
  const names = new Set<string>();
  for (const tool of tools) {
    if (names.has(tool.name)) {
      // [LAW:no-silent-failure] a duplicate name would shadow a tool at startup
      throw new Error(`duplicate tool name: ${tool.name}`);
    }
    names.add(tool.name);
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema },
      async (args: Record<string, unknown>) => {
        try {
          const result = await tool.handler(client, args);
          return {
            content: [
              {
                type: "text" as const,
                text: typeof result === "string" ? result : JSON.stringify(result, null, 1),
              },
            ],
          };
        } catch (error) {
          // [LAW:no-silent-failure] failures reach the model as tool errors with
          // the actionable message intact, never as empty successes.
          const text =
            error instanceof RewApiError || error instanceof Error
              ? error.message
              : String(error);
          return { content: [{ type: "text" as const, text }], isError: true };
        }
      },
    );
  }
}
