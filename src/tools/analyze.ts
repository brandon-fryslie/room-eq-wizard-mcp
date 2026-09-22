import { z } from "zod";
import { defineTool, measurementIdInput } from "./registry.js";
import { decimateLog, diffSpectra, summarizeSpectrum } from "../analysis/spectrum.js";
import { correlateModes, roomModes, schroederFrequency } from "../analysis/room-modes.js";
import { fetchSpectrum } from "./shared.js";
import { SMOOTHING_VALUES } from "../rew/types.js";

const dimensionsInput = {
  lengthM: z.number().positive().describe("Room length in metres"),
  widthM: z.number().positive().describe("Room width in metres"),
  heightM: z.number().positive().describe("Room height in metres"),
};

export const analyzeTools = [
  defineTool({
    name: "analyze_response",
    description:
      "Interpret a measurement's frequency response: per-band levels, flatness, and detected peaks and nulls with frequency, deviation, Q, and severity. The primary tool for answering 'what is wrong with this response?' Analyses the curve at the smoothing you pass (default 1/12), independently of the smoothing the measurement is displaying — widen it if the detector is reporting narrow features you do not believe.",
    inputSchema: {
      measurement: measurementIdInput,
      windowOctaves: z
        .number()
        .min(0.2)
        .max(3)
        .default(1)
        .describe("Octave span of the baseline used to judge deviations — smaller finds narrower features"),
      minDeviationDb: z
        .number()
        .min(1)
        .max(20)
        .default(3)
        .describe("Smallest |deviation| in dB reported as a peak or null"),
      smoothing: z
        .enum(SMOOTHING_VALUES)
        .default("1/12")
        .describe(
          "Smoothing the analysis runs on. 1/12 keeps modal features while suppressing " +
            "measurement grass; widen (1/6, 1/3) to stop the detector inventing narrow " +
            "peaks, narrow (1/24, 1/48) to resolve close modes.",
        ),
    },
    handler: async (client, args) => {
      // The analysed smoothing is the caller's, not the measurement's display state —
      // so this answers the same way whatever the GUI happens to be showing.
      const spectrum = await fetchSpectrum(client, args.measurement, {
        ppo: 96,
        smoothing: args.smoothing,
      });
      return {
        // Report what was analysed: two runs that disagree should say why.
        smoothing: spectrum.smoothing ?? args.smoothing,
        ...summarizeSpectrum(spectrum.freqsHz, spectrum.magDb, {
          windowOctaves: args.windowOctaves,
          minDeviationDb: args.minDeviationDb,
        }),
      };
    },
  }),
  defineTool({
    name: "compare_measurements",
    description:
      "Compare two measurements (e.g. before/after EQ, left/right symmetry): the A-minus-B difference curve summarised per band, plus the largest divergences. Positive values mean A is hotter.",
    inputSchema: {
      measurementA: measurementIdInput,
      measurementB: measurementIdInput,
      maxPoints: z.number().int().min(10).max(300).default(60).describe("Points of the difference curve to return"),
    },
    handler: async (client, args) => {
      const [a, b] = await Promise.all([
        fetchSpectrum(client, args.measurementA, { ppo: 96, smoothing: "1/6" }),
        fetchSpectrum(client, args.measurementB, { ppo: 96, smoothing: "1/6" }),
      ]);
      const diff = diffSpectra(a, b);
      const summary = summarizeSpectrum(diff.freqsHz, diff.magDb, { minDeviationDb: 3 });
      return {
        meaning: "levels are A minus B in dB; positive = A hotter",
        overallOffsetDb: summary.meanDb,
        matchStdDevDb: summary.stdDevDb,
        bands: summary.bands,
        largestDivergences: [...summary.peaks, ...summary.nulls].sort(
          (x, y) => Math.abs(y.deviationDb) - Math.abs(x.deviationDb),
        ),
        differenceCurve: decimateLog(diff.freqsHz, diff.magDb, args.maxPoints),
      };
    },
  }),
  defineTool({
    name: "room_mode_analysis",
    description:
      "Predict rectangular-room standing-wave modes from room dimensions, and optionally correlate them with the measured peaks/nulls of a measurement to identify which response problems are modal (EQ can tame modal peaks; modal nulls need placement or treatment).",
    inputSchema: {
      ...dimensionsInput,
      measurement: measurementIdInput.optional().describe(
        "Measurement to correlate against the predicted modes",
      ),
      maxHz: z.number().min(50).max(500).default(300).describe("Upper frequency bound for mode prediction"),
      rt60Seconds: z
        .number()
        .positive()
        .optional()
        .describe("Mid-band RT60 in seconds — enables the Schroeder frequency estimate"),
    },
    handler: async (client, args) => {
      const dims = { lengthM: args.lengthM, widthM: args.widthM, heightM: args.heightM };
      const modes = roomModes(dims, args.maxHz);
      const volumeM3 = args.lengthM * args.widthM * args.heightM;
      const result: Record<string, unknown> = {
        roomVolumeM3: Math.round(volumeM3 * 100) / 100,
        schroederHz:
          args.rt60Seconds !== undefined ? schroederFrequency(args.rt60Seconds, volumeM3) : undefined,
        axialModes: modes.filter((m) => m.type === "axial"),
        tangentialCount: modes.filter((m) => m.type === "tangential").length,
        obliqueCount: modes.filter((m) => m.type === "oblique").length,
      };
      if (args.measurement !== undefined) {
        const spectrum = await fetchSpectrum(client, args.measurement, { ppo: 96, smoothing: "1/12" });
        const summary = summarizeSpectrum(spectrum.freqsHz, spectrum.magDb, { windowOctaves: 1 });
        const measured = [...summary.peaks, ...summary.nulls].filter((e) => e.hz <= args.maxHz);
        result.measuredLowFrequencyFeatures = measured;
        result.modalMatches = correlateModes(modes, measured);
      }
      return result;
    },
  }),
];
