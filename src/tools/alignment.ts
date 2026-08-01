// REW's alignment tool is a stateful sub-resource: knobs are set at
// /alignment-tool/* endpoints, then a command acts on the configured pair.
// [LAW:no-ambient-temporal-coupling] the settings-before-command sequencing is
// owned here, inside each handler — callers never perform a setup ritual.
//
// Command names: "Align phase" and "Aligned sum" are pinned from the reference
// implementations; the full authoritative list is whatever REW answers at
// /alignment-tool/commands (surfaced by get_alignment_state, exercised by
// run_alignment_command, and reality-checked by the live suite).

import { z } from "zod";
import { defineTool, measurementIdInput } from "./registry.js";
import type { RewClient } from "../rew/client.js";
import { unknownSchema, wireNumberSchema } from "../rew/types.js";
import { newestMeasurement, resolveIndex, summarize } from "./shared.js";

/** Every readable knob of the alignment tool, in wire endpoint spelling. */
export const alignmentStateEndpoints = [
  "mode",
  "frequency",
  "index-a",
  "index-b",
  "gain-a",
  "gain-b",
  "delay-a",
  "delay-b",
  "invert-a",
  "invert-b",
  "max-positive-delay",
  "max-negative-delay",
] as const;

// [LAW:dataflow-not-control-flow] one fixed write pipeline for every knob;
// undefined is the identity value, so which knobs change is data, not branches.
async function postSettings(client: RewClient, settings: Record<string, unknown>): Promise<void> {
  for (const [endpoint, value] of Object.entries(settings)) {
    if (value !== undefined) await client.post(`/alignment-tool/${endpoint}`, value);
  }
}

async function readState(client: RewClient): Promise<Record<string, unknown>> {
  const state: Record<string, unknown> = {};
  for (const endpoint of alignmentStateEndpoints) {
    state[endpoint] = await client.get(`/alignment-tool/${endpoint}`, unknownSchema);
  }
  return state;
}

export const alignmentTools = [
  defineTool({
    name: "align_measurements",
    description:
      "Phase-align measurement B to measurement A at a frequency (typically the crossover) using REW's alignment tool, and report the delay REW computed for B. The standard sub-to-main time alignment: A is the reference (mains), B is the one being delayed (sub). The result stays in the alignment tool's preview state — follow with create_aligned_sum for the summed measurement, or apply the reported delay in your DSP.",
    inputSchema: {
      measurementA: measurementIdInput.describe("Reference measurement (e.g. mains), UUID or 1-based index"),
      measurementB: measurementIdInput.describe("Measurement to delay (e.g. sub), UUID or 1-based index"),
      frequencyHz: z
        .number()
        .positive()
        .default(80)
        .describe("Alignment frequency in Hz — use the crossover frequency"),
      invertB: z.boolean().default(false).describe("Invert B's polarity before aligning"),
      maxPositiveDelayMs: z.number().optional().describe("Largest positive delay REW may apply to B, ms"),
      maxNegativeDelayMs: z.number().optional().describe("Largest negative delay REW may apply to B, ms"),
    },
    handler: async (client, args) => {
      const indexA = await resolveIndex(client, args.measurementA);
      const indexB = await resolveIndex(client, args.measurementB);
      await postSettings(client, {
        "index-a": indexA,
        "index-b": indexB,
        mode: "Phase",
        "invert-b": args.invertB,
        "max-positive-delay": args.maxPositiveDelayMs,
        "max-negative-delay": args.maxNegativeDelayMs,
      });
      const result = await client.command("/alignment-tool/command", {
        command: "Align phase",
        frequency: args.frequencyHz,
      });
      const delayBMs = await client.get("/alignment-tool/delay-b", wireNumberSchema);
      return {
        delayBMs,
        invertB: args.invertB,
        frequencyHz: args.frequencyHz,
        result: result ?? "completed",
      };
    },
  }),
  defineTool({
    name: "create_aligned_sum",
    description:
      "Create a new measurement containing the sum of the alignment tool's A and B with the current gain/delay/polarity settings applied. Run align_measurements (or configure_alignment) first to set the pair up.",
    inputSchema: {},
    handler: async (client) => {
      const result = await client.command("/alignment-tool/command", { command: "Aligned sum" });
      const created = await newestMeasurement(client);
      return {
        result: result ?? "completed",
        newestMeasurement: created !== null ? summarize(created) : null,
      };
    },
  }),
  defineTool({
    name: "get_alignment_state",
    description:
      "Read the alignment tool's full state: mode, frequency, the A/B measurement indices, per-side gain/delay/polarity, delay limits, plus the modes and commands this REW version accepts.",
    inputSchema: {},
    handler: async (client) => ({
      ...(await readState(client)),
      availableModes: await client.get("/alignment-tool/modes", unknownSchema),
      availableCommands: await client.get("/alignment-tool/commands", unknownSchema),
    }),
  }),
  defineTool({
    name: "configure_alignment",
    description:
      "Set any subset of the alignment tool's knobs — measurement pair, mode (Phase/Impulse), frequency, per-side gain/delay/polarity, delay limits — and return the resulting state. For manual what-if adjustments; align_measurements does the standard phase-align in one call.",
    inputSchema: {
      measurementA: measurementIdInput.optional().describe("Measurement for slot A, UUID or 1-based index"),
      measurementB: measurementIdInput.optional().describe("Measurement for slot B, UUID or 1-based index"),
      mode: z.enum(["Phase", "Impulse"]).optional().describe("Alignment mode"),
      frequencyHz: z.number().positive().optional().describe("Alignment frequency, Hz"),
      gainADb: z.number().optional().describe("Gain applied to A, dB"),
      gainBDb: z.number().optional().describe("Gain applied to B, dB"),
      delayAMs: z.number().optional().describe("Delay applied to A, ms"),
      delayBMs: z.number().optional().describe("Delay applied to B, ms"),
      invertA: z.boolean().optional().describe("Invert A's polarity"),
      invertB: z.boolean().optional().describe("Invert B's polarity"),
      maxPositiveDelayMs: z.number().optional(),
      maxNegativeDelayMs: z.number().optional(),
    },
    handler: async (client, args) => {
      const indexA =
        args.measurementA !== undefined ? await resolveIndex(client, args.measurementA) : undefined;
      const indexB =
        args.measurementB !== undefined ? await resolveIndex(client, args.measurementB) : undefined;
      const settings = {
        "index-a": indexA,
        "index-b": indexB,
        mode: args.mode,
        frequency: args.frequencyHz,
        "gain-a": args.gainADb,
        "gain-b": args.gainBDb,
        "delay-a": args.delayAMs,
        "delay-b": args.delayBMs,
        "invert-a": args.invertA,
        "invert-b": args.invertB,
        "max-positive-delay": args.maxPositiveDelayMs,
        "max-negative-delay": args.maxNegativeDelayMs,
      };
      if (Object.values(settings).every((value) => value === undefined)) {
        throw new Error("provide at least one alignment setting to change");
      }
      await postSettings(client, settings);
      return readState(client);
    },
  }),
  defineTool({
    name: "run_alignment_command",
    description:
      "Run a raw alignment tool command (discover names with get_alignment_state's availableCommands). Escape hatch for commands without a dedicated tool, e.g. impulse-mode alignment or 'Aligned copy'. Extra parameters merge into the command body at the top level.",
    inputSchema: {
      command: z.string().describe("Alignment tool command name, e.g. 'Align phase'"),
      parameters: z
        .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
        .optional()
        .describe("Extra top-level command fields, e.g. { \"frequency\": 80 }"),
    },
    handler: async (client, args) => {
      const result = await client.command("/alignment-tool/command", {
        command: args.command,
        ...args.parameters,
      });
      return result ?? `Command '${args.command}' completed`;
    },
  }),
];
