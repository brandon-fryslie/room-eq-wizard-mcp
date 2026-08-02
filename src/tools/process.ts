import { z } from "zod";
import { defineTool, measurementIdInput } from "./registry.js";
import type { RewClient } from "../rew/client.js";
import { measurementsCreatedBy, newestMeasurement, summarize } from "./shared.js";

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
      // The inversion/merge parameters that turn a raw 1/A into a usable correction curve.
      mergeFrequencyHz: z.number().optional().describe("Frequency at which to perform a merge function, Hz"),
      mergeBlend: z.boolean().optional().describe("Blend a merge function over a span"),
      targetLevelDb: z.number().optional().describe("Target level for an inversion function, dB"),
      autoTarget: z.boolean().optional().describe("Set the inversion target level automatically"),
      excludeNotches: z.boolean().optional().describe("Exclude notches when inverting (avoids boosting nulls)"),
    },
    handler: (client, args) =>
      runProcess(client, "Arithmetic", [args.measurementA, args.measurementB], {
        function: args.operation,
        maxGain: args.maxGainDb !== undefined ? String(args.maxGainDb) : undefined,
        lowerLimit: args.lowerLimitHz !== undefined ? String(args.lowerLimitHz) : undefined,
        upperLimit: args.upperLimitHz !== undefined ? String(args.upperLimitHz) : undefined,
        mergeFrequency: args.mergeFrequencyHz !== undefined ? String(args.mergeFrequencyHz) : undefined,
        mergeBlend: args.mergeBlend,
        targetLevel: args.targetLevelDb !== undefined ? String(args.targetLevelDb) : undefined,
        autoTarget: args.autoTarget,
        excludeNotches: args.excludeNotches,
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
  defineTool({
    name: "align_ir",
    description:
      "Time-align the impulse responses of several measurements so they line up for comparison or summation: 'Time align' aligns by IR timing, 'Align IR start' aligns the IR starts, 'Cross corr align' aligns by cross-correlation, 'Remove IR delays' zeroes each measurement's delay. Modifies the measurements' timing in place.",
    inputSchema: {
      measurements: z.array(measurementIdInput).min(1).describe("Measurements to align"),
      method: z
        .enum(["Time align", "Align IR start", "Cross corr align", "Remove IR delays"])
        .default("Time align")
        .describe("Alignment method"),
    },
    handler: (client, args) => runProcess(client, args.method, args.measurements, {}),
  }),
  defineTool({
    name: "generate_phase_version",
    description:
      "Generate a minimum-phase or excess-phase version of a measurement as a NEW measurement. Minimum phase is the ideal EQ-correctable response; excess phase is what remains (delay + non-minimum-phase behaviour). Optional low/high-frequency tail extrapolation improves the transform at the band edges — if you append a tail, provide its start frequency and slope.",
    inputSchema: {
      measurement: measurementIdInput,
      kind: z.enum(["minimum", "excess"]).default("minimum").describe("Which phase version to generate"),
      includeCal: z.boolean().default(true).describe("Include calibration data in the transform"),
      appendLfTail: z.boolean().default(false).describe("Extrapolate a low-frequency tail"),
      lfTailStartHz: z.number().positive().optional().describe("LF tail start frequency, Hz (with appendLfTail)"),
      lfTailSlopeDbPerOctave: z.number().min(0).optional().describe("LF tail slope, dB/octave (>= 0)"),
      appendHfTail: z.boolean().default(false).describe("Extrapolate a high-frequency tail"),
      hfTailStartHz: z.number().positive().optional().describe("HF tail start frequency, Hz (with appendHfTail)"),
      hfTailSlopeDbPerOctave: z.number().max(0).optional().describe("HF tail slope, dB/octave (<= 0)"),
      frequencyWarping: z.boolean().default(false).describe("Apply frequency warping (with appendHfTail)"),
      replicateData: z.boolean().default(false).describe("Replicate data when a tail is not appended"),
    },
    handler: async (client, args) => {
      const command = args.kind === "minimum" ? "Minimum phase version" : "Excess phase version";
      // [LAW:dataflow-not-control-flow] one flat parameter object; unset optionals are
      // dropped by JSON serialisation, so the tail params appear only when supplied.
      const parameters = {
        "include cal": args.includeCal,
        "append lf tail": args.appendLfTail,
        "lf tail start": args.lfTailStartHz,
        "lf tail slope": args.lfTailSlopeDbPerOctave,
        "append hf tail": args.appendHfTail,
        "hf tail start": args.hfTailStartHz,
        "hf tail slope": args.hfTailSlopeDbPerOctave,
        "frequency warping": args.frequencyWarping,
        "replicate data": args.replicateData,
      };
      const { created } = await measurementsCreatedBy(client, () =>
        client.command(`/measurements/${encodeURIComponent(args.measurement)}/command`, { command, parameters }),
      );
      if (created.length === 0) {
        // [LAW:no-silent-failure] the point is a new measurement; none means it failed.
        throw new Error(`${command} produced no measurement — the source needs a valid impulse response`);
      }
      return { command, measurement: summarize(created[created.length - 1]) };
    },
  }),
];
