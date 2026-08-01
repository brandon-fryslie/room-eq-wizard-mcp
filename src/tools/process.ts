import { z } from "zod";
import { defineTool, measurementIdInput } from "./registry.js";
import type { RewClient } from "../rew/client.js";
import { newestMeasurement, summarize } from "./shared.js";

/** Run a process over measurement UUIDs/indices and report what it produced. */
async function runProcess(
  client: RewClient,
  processName: string,
  measurements: string[],
  parameters: Record<string, unknown>,
): Promise<unknown> {
  const result = await client.command("/measurements/process-measurements", {
    processName,
    measurementUUIDs: measurements,
    parameters,
  });
  const created = await newestMeasurement(client);
  return {
    processName,
    result: result ?? "completed",
    newestMeasurement: created !== null ? summarize(created) : null,
  };
}

export const processTools = [
  defineTool({
    name: "average_measurements",
    description:
      "Average several measurements into a new one — the standard way to combine multiple mic positions. Vector average is REW's recommended default for spatial averaging.",
    inputSchema: {
      measurements: z.array(measurementIdInput).min(2).describe("Measurements to average"),
      method: z
        .enum([
          "Vector average",
          "RMS average",
          "dB average",
          "Magn plus phase average",
          "dB plus phase average",
          "Vector sum",
        ])
        .default("Vector average"),
    },
    handler: (client, args) => runProcess(client, args.method, args.measurements, {}),
  }),
  defineTool({
    name: "align_spl",
    description:
      "Align the SPL of several measurements to a target level (or to their average) around a centre frequency — level-matching before comparison or averaging.",
    inputSchema: {
      measurements: z.array(measurementIdInput).min(1),
      targetDb: z
        .string()
        .default("average")
        .describe("Target SPL in dB (e.g. '75.0') or 'average' to align to the group average"),
      frequencyHz: z.number().positive().default(1000).describe("Centre frequency for the alignment"),
      spanOctaves: z.number().positive().default(2).describe("Averaging span around the centre, octaves"),
    },
    handler: (client, args) =>
      runProcess(client, "Align SPL", args.measurements, {
        targetdB: args.targetDb,
        frequencyHz: String(args.frequencyHz),
        spanOctaves: args.spanOctaves,
      }),
  }),
  defineTool({
    name: "arithmetic",
    description:
      "Trace arithmetic on a pair of measurements (first = A, second = B): division for transfer functions, subtraction for difference curves, inversion for correction curves, etc. Produces a new measurement.",
    inputSchema: {
      measurementA: measurementIdInput,
      measurementB: measurementIdInput,
      operation: z
        .string()
        .describe("REW arithmetic function, e.g. 'A + B', 'A - B', 'A * B', 'A / B', '1 / A', '|A|'"),
      maxGainDb: z.number().optional().describe("Gain limit for division/inversion, dB"),
      lowerLimitHz: z.number().optional().describe("Lower band limit for division/inversion, Hz"),
      upperLimitHz: z.number().optional().describe("Upper band limit for division/inversion, Hz"),
    },
    handler: (client, args) =>
      runProcess(client, "Arithmetic", [args.measurementA, args.measurementB], {
        function: args.operation,
        maxGain: args.maxGainDb !== undefined ? String(args.maxGainDb) : undefined,
        lowerLimit: args.lowerLimitHz !== undefined ? String(args.lowerLimitHz) : undefined,
        upperLimit: args.upperLimitHz !== undefined ? String(args.upperLimitHz) : undefined,
      }),
  }),
  defineTool({
    name: "smooth_measurement",
    description: "Apply fractional-octave smoothing to a measurement (changes the measurement in place).",
    inputSchema: {
      measurement: measurementIdInput,
      smoothing: z
        .enum(["1/1", "1/2", "1/3", "1/6", "1/12", "1/24", "1/48", "Variable", "Psychoacoustic", "ERB", "None"])
        .describe("Smoothing to apply"),
    },
    handler: async (client, args) => {
      await client.command(`/measurements/${encodeURIComponent(args.measurement)}/command`, {
        command: "Smooth",
        parameters: { smoothing: args.smoothing },
      });
      return `Applied ${args.smoothing} smoothing to ${args.measurement}`;
    },
  }),
  defineTool({
    name: "add_spl_offset",
    description: "Shift a measurement's SPL level by a fixed offset in dB (changes the measurement in place).",
    inputSchema: {
      measurement: measurementIdInput,
      offsetDb: z.number().describe("Offset to add, dB (negative to lower)"),
    },
    handler: async (client, args) => {
      await client.command(`/measurements/${encodeURIComponent(args.measurement)}/command`, {
        command: "Add SPL offset",
        parameters: { offset: args.offsetDb },
      });
      return `Added ${args.offsetDb} dB offset to ${args.measurement}`;
    },
  }),
];
