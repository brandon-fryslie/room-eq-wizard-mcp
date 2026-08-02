import { z } from "zod";
import { defineTool } from "./registry.js";
import type { RewClient } from "../rew/client.js";
import { unknownSchema } from "../rew/types.js";
import { listMeasurements } from "./shared.js";

async function readDiagnostics(client: RewClient): Promise<Record<string, unknown>> {
  const read = (path: string) => client.get(path, unknownSchema);
  const [lastError, lastWarning, errors, warnings, inhibitGraphUpdates, apiLogging] = await Promise.all([
    read("/application/last-error"),
    read("/application/last-warning"),
    read("/application/errors"),
    read("/application/warnings"),
    read("/application/inhibit-graph-updates"),
    read("/application/logging"),
  ]);
  return { lastError, lastWarning, errors, warnings, inhibitGraphUpdates, apiLogging };
}

export const statusTools = [
  defineTool({
    name: "status",
    description:
      "Check the REW API connection and report application state: reachability, measurement count, and any logged errors or warnings. Run this first if other tools fail.",
    inputSchema: {},
    handler: async (client) => {
      // Reachability is proven by the commands endpoint answering at all.
      await client.get("/application/commands", unknownSchema);
      const measurements = await listMeasurements(client);
      const errors = await client.get("/application/errors", unknownSchema);
      const warnings = await client.get("/application/warnings", unknownSchema);
      return {
        connected: true,
        apiUrl: client.baseUrl,
        measurementCount: measurements.length,
        errors,
        warnings,
      };
    },
  }),
  defineTool({
    name: "list_api_commands",
    description:
      "List the raw commands a REW endpoint area accepts (application, measurements, measure, generator, rta, or a specific measurement's commands). Useful to discover REW capabilities not covered by a dedicated tool.",
    inputSchema: {
      area: z
        .enum(["application", "measurements", "measure", "generator", "rta"])
        .describe("Which REW command list to read"),
    },
    handler: async (client, args) => {
      const paths = {
        application: "/application/commands",
        measurements: "/measurements/commands",
        measure: "/measure/commands",
        generator: "/generator/commands",
        rta: "/rta/commands",
      } as const;
      return client.get(paths[args.area], unknownSchema);
    },
  }),
  defineTool({
    name: "get_diagnostics",
    description:
      "Read REW's diagnostics: the last error and last warning, the full error and warning logs, and the current diagnostic flags (whether graph updates are inhibited and whether API-message logging is on). Use when a command misbehaves or to check what REW complained about.",
    inputSchema: {},
    handler: async (client) => readDiagnostics(client),
  }),
  defineTool({
    name: "configure_application",
    description:
      "Set REW's diagnostic flags: inhibitGraphUpdates suppresses graph redraws during bulk delete/modify operations (avoids GUI churn and partial-data errors); apiLogging logs API messages to rew_output.txt for debugging. Applies whichever are provided and returns the resulting diagnostics.",
    inputSchema: {
      inhibitGraphUpdates: z
        .boolean()
        .optional()
        .describe("Suppress graph updates (set true around bulk measurement changes)"),
      apiLogging: z.boolean().optional().describe("Log API messages to rew_output.txt for debugging"),
    },
    handler: async (client, args) => {
      if (args.inhibitGraphUpdates === undefined && args.apiLogging === undefined) {
        // [LAW:no-silent-failure] a no-op configure is a caller mistake, not success.
        throw new Error("provide inhibitGraphUpdates and/or apiLogging to change");
      }
      if (args.inhibitGraphUpdates !== undefined) {
        await client.post("/application/inhibit-graph-updates", args.inhibitGraphUpdates);
      }
      if (args.apiLogging !== undefined) await client.post("/application/logging", args.apiLogging);
      return readDiagnostics(client);
    },
  }),
  defineTool({
    name: "clear_command_in_progress",
    description:
      "Clear REW's internal 'command in progress' record — the recovery for a wedged command. REW blocks a new command until the previous one completes; if an error left that record stuck, this resets it so commands work again.",
    inputSchema: {},
    handler: async (client) => {
      const result = await client.post("/application/command", { command: "Clear command in progress" });
      return result ?? "cleared";
    },
  }),
  defineTool({
    name: "shutdown_rew",
    description:
      "Shut REW down — for headless (-nogui) operation when you are done driving it. This CLOSES the REW application; the API becomes unreachable afterwards. Destructive and irreversible from the API, so it requires confirm=true.",
    inputSchema: {
      confirm: z.boolean().describe("Must be true to actually shut REW down (a guard against accidental shutdown)"),
    },
    handler: async (client, args) => {
      if (args.confirm !== true) {
        // [LAW:no-silent-failure] refuse to shut down without explicit confirmation.
        throw new Error("shutdown_rew requires confirm=true — this closes REW and makes the API unreachable");
      }
      // Plain POST, never blocking: REW exits, so a blocking call could never return.
      await client.post("/application/command", { command: "Shutdown" });
      return { shuttingDown: true };
    },
  }),
];
