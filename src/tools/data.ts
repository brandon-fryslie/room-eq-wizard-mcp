import { z } from "zod";
import { defineTool, measurementIdInput } from "./registry.js";
import {
  distortionSchema,
  impulseResponseSchema,
  rt60Schema,
  spectrumSchema,
  unknownSchema,
} from "../rew/types.js";
import { decodeFloats } from "../rew/codec.js";
import { decimateLog, summarizeSpectrum } from "../analysis/spectrum.js";
import { fetchSpectrum } from "./shared.js";

// IR reads share the "no impulse response → { message }" wire behaviour: the IR shape
// (required `data`) is tried first, the sentinel falls through. [LAW:parse-dont-validate]
const irOrMessageSchema = z.union([impulseResponseSchema, z.looseObject({ message: z.string() })]);

const smoothingInput = z
  .string()
  .optional()
  .describe("REW smoothing, e.g. '1/6', '1/12', 'Variable', 'None' (default: the measurement's current smoothing)");

export const dataTools = [
  defineTool({
    name: "get_frequency_response",
    description:
      "Get a measurement's frequency response as a log-spaced curve, decimated to a readable number of points, plus summary statistics. For interpretation (peaks/nulls/band balance) prefer analyze_response.",
    inputSchema: {
      measurement: measurementIdInput,
      smoothing: smoothingInput,
      maxPoints: z
        .number()
        .int()
        .min(10)
        .max(500)
        .default(120)
        .describe("Maximum points returned (log-spaced bin averages)"),
    },
    handler: async (client, args) => {
      const spectrum = await fetchSpectrum(client, args.measurement, {
        smoothing: args.smoothing,
        ppo: 96,
      });
      const summary = summarizeSpectrum(spectrum.freqsHz, spectrum.magDb);
      return {
        unit: spectrum.unit,
        smoothing: spectrum.smoothing,
        rangeHz: summary.rangeHz,
        meanDb: summary.meanDb,
        stdDevDb: summary.stdDevDb,
        points: decimateLog(spectrum.freqsHz, spectrum.magDb, args.maxPoints),
      };
    },
  }),
  defineTool({
    name: "get_rt60",
    description:
      "Generate and read RT60 / ISO 3382 decay parameters (EDT, T20, T30, Topt) per octave or one-third-octave band. Requires the measurement to have an impulse response (swept measurements do).",
    inputSchema: {
      measurement: measurementIdInput,
      octaveFraction: z
        .enum(["1", "3"])
        .default("1")
        .describe("'1' for octave bands, '3' for one-third-octave bands"),
    },
    handler: async (client, args) => {
      const id = encodeURIComponent(args.measurement);
      await client.command(`/measurements/${id}/command`, {
        command: "Generate RT60",
        parameters: {
          octaveFrac: Number(args.octaveFraction),
          filterOrder: 6,
          zeroPhaseFiltered: true,
          reverseFiltered: false,
        },
      });
      return client.get(`/measurements/${id}/rt60`, rt60Schema, {
        octaveFrac: args.octaveFraction,
      });
    },
  }),
  defineTool({
    name: "get_distortion",
    description:
      "Get a measurement's distortion data (THD and harmonics) as a table. Only meaningful for measurements captured with distortion analysis (swept sine).",
    inputSchema: {
      measurement: measurementIdInput,
      ppo: z.number().int().min(1).max(48).default(3).describe("Frequency resolution, points per octave"),
      unit: z.string().optional().describe("Distortion unit, e.g. 'percent' (default) or 'dBr'"),
    },
    handler: async (client, args) =>
      client.get(`/measurements/${encodeURIComponent(args.measurement)}/distortion`, distortionSchema, {
        ppo: args.ppo,
        unit: args.unit,
      }),
  }),
  defineTool({
    name: "get_impulse_response",
    description:
      "Read a measurement's impulse response metadata and peak — sample rate, sample interval, start time, length, and the peak sample. Returns statistics, not the raw sample array (which is large). Swept measurements have an IR; FR-only imports do not.",
    inputSchema: {
      measurement: measurementIdInput,
      windowed: z.boolean().default(false).describe("Return only the windowed portion of the IR"),
      normalised: z.boolean().default(true).describe("Normalise the IR data (false for raw amplitudes)"),
    },
    handler: async (client, args) => {
      const ir = await client.get(
        `/measurements/${encodeURIComponent(args.measurement)}/impulse-response`,
        irOrMessageSchema,
        { windowed: args.windowed, normalised: args.normalised },
      );
      if (typeof ir.data !== "string") {
        // [LAW:no-silent-failure] no IR is a real state (e.g. an FR-only import) to report.
        throw new Error(
          `measurement has no impulse response (REW: "${String(ir.message)}") — only measurements ` +
            `with an IR (swept, or imported IR) have one`,
        );
      }
      const samples = decodeFloats(ir.data);
      let peak = 0;
      for (const s of samples) peak = Math.max(peak, Math.abs(s));
      return {
        sampleRate: ir.sampleRate,
        sampleIntervalSeconds: ir.sampleInterval,
        startTimeSeconds: ir.startTime,
        timingReference: ir.timingReference,
        numSamples: samples.length,
        windowed: args.windowed,
        normalised: args.normalised,
        peakSample: peak,
      };
    },
  }),
  defineTool({
    name: "get_group_delay",
    description:
      "Read a measurement's group delay versus frequency as a log-spaced, decimated curve. Values are in seconds; large swings indicate phase distortion. Requires an impulse response.",
    inputSchema: {
      measurement: measurementIdInput,
      maxPoints: z.number().int().min(10).max(500).default(120).describe("Maximum points (log-spaced)"),
    },
    handler: async (client, args) => {
      const gd = await client.get(
        `/measurements/${encodeURIComponent(args.measurement)}/group-delay`,
        spectrumSchema,
        { ppo: 96 },
      );
      return {
        unit: gd.unit ?? "seconds",
        rangeHz: [Math.round(gd.freqsHz[0] * 10) / 10, Math.round(gd.freqsHz[gd.freqsHz.length - 1] * 10) / 10],
        points: decimateLog(gd.freqsHz, gd.magDb, args.maxPoints),
      };
    },
  }),
  defineTool({
    name: "ir_windows",
    description:
      "Read or change a measurement's impulse-response window settings — left/right window types and widths, the reference time, and the frequency-dependent window (FDW). Call with no settings to read; provide any subset to change them (merged over current). Fields: leftWindowType, rightWindowType, leftWindowWidthms, rightWindowWidthms, refTimems, addFDW, fdwWidthCycles.",
    inputSchema: {
      measurement: measurementIdInput,
      settings: z
        .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
        .optional()
        .describe('Window fields to change, e.g. { "addFDW": true, "fdwWidthCycles": 15 }'),
    },
    handler: async (client, args) => {
      const endpoint = `/measurements/${encodeURIComponent(args.measurement)}/ir-windows`;
      if (args.settings !== undefined && Object.keys(args.settings).length > 0) {
        // Merge over current so unspecified window fields are preserved; PUT is the write verb.
        const current = await client.get(endpoint, z.looseObject({}));
        await client.put(endpoint, { ...current, ...args.settings });
      }
      return client.get(endpoint, unknownSchema);
    },
  }),
];
