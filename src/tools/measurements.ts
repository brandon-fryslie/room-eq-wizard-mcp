import { z } from "zod";
import { defineTool, measurementIdInput } from "./registry.js";
import { measurementSummarySchema, unknownSchema } from "../rew/types.js";
import { listMeasurements, summarize } from "./shared.js";

export const measurementTools = [
  defineTool({
    name: "list_measurements",
    description:
      "List all measurements currently loaded in REW, with UUID, index, title, notes, date, and frequency range. UUIDs are the stable way to reference a measurement in other tools.",
    inputSchema: {},
    handler: async (client) => (await listMeasurements(client)).map(summarize),
  }),
  defineTool({
    name: "get_measurement",
    description: "Get the full summary of one measurement (all metadata REW holds for it).",
    inputSchema: { measurement: measurementIdInput },
    handler: async (client, args) =>
      client.get(`/measurements/${encodeURIComponent(args.measurement)}`, measurementSummarySchema),
  }),
  defineTool({
    name: "rename_measurement",
    description: "Change a measurement's title and/or notes.",
    inputSchema: {
      measurement: measurementIdInput,
      title: z.string().optional().describe("New title"),
      notes: z.string().optional().describe("New notes"),
    },
    handler: async (client, args) => {
      if (args.title === undefined && args.notes === undefined) {
        throw new Error("provide title, notes, or both");
      }
      await client.put(`/measurements/${encodeURIComponent(args.measurement)}`, {
        title: args.title,
        notes: args.notes,
      });
      return `Updated measurement ${args.measurement}`;
    },
  }),
  defineTool({
    name: "delete_measurement",
    description:
      "Delete one measurement from REW. There is no confirmation and no undo — REW deletes immediately.",
    inputSchema: { measurement: measurementIdInput },
    handler: async (client, args) => {
      await client.delete(`/measurements/${encodeURIComponent(args.measurement)}`);
      return `Deleted measurement ${args.measurement}`;
    },
  }),
  defineTool({
    name: "save_all_measurements",
    description:
      "Save every loaded measurement to a single .mdat file (overwrites an existing file at that path). Use forward slashes in the path.",
    inputSchema: {
      path: z.string().describe("Destination .mdat file path, forward slashes"),
      note: z.string().optional().describe("Note stored with the file"),
    },
    handler: async (client, args) => {
      await client.command("/measurements/command", {
        command: "Save all",
        parameters: args.note !== undefined ? [args.path, args.note] : [args.path],
      });
      return `Saved all measurements to ${args.path}`;
    },
  }),
  defineTool({
    name: "load_measurement_files",
    description:
      "Load one or more .mdat measurement files into REW. Returns the measurements that appeared.",
    inputSchema: {
      paths: z.array(z.string()).min(1).describe("File paths to load, forward slashes"),
    },
    handler: async (client, args) => {
      const before = new Set((await listMeasurements(client)).map((m) => m.uuid));
      await client.command("/measurements/command", { command: "Load", parameters: args.paths });
      const after = await listMeasurements(client);
      const loaded = after.filter((m) => !before.has(m.uuid));
      return { loadedCount: loaded.length, loaded: loaded.map(summarize) };
    },
  }),
  defineTool({
    name: "run_measurement_command",
    description:
      "Run a raw REW command on one measurement (discover names with list_api_commands / the measurement's own command list). Escape hatch for operations without a dedicated tool, e.g. 'Trim IR to windows' or 'Estimate IR delay'.",
    inputSchema: {
      measurement: measurementIdInput,
      command: z.string().describe("REW command name, e.g. 'Estimate IR delay'"),
      parameters: z
        .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
        .optional()
        .describe("Command parameters as REW documents them"),
    },
    handler: async (client, args) => {
      const result = await client.command(
        `/measurements/${encodeURIComponent(args.measurement)}/command`,
        { command: args.command, parameters: args.parameters },
      );
      return result ?? `Command '${args.command}' completed`;
    },
  }),
  defineTool({
    name: "get_measurement_commands",
    description: "List the commands REW accepts for a specific measurement.",
    inputSchema: { measurement: measurementIdInput },
    handler: async (client, args) =>
      client.get(`/measurements/${encodeURIComponent(args.measurement)}/commands`, unknownSchema),
  }),
];
