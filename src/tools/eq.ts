import { z } from "zod";
import { defineTool, measurementIdInput } from "./registry.js";
import type { RewClient } from "../rew/client.js";
import { filterListSchema, spectrumSchema, unknownSchema } from "../rew/types.js";
import { decodeFloats } from "../rew/codec.js";
import { decimateLog, summarizeSpectrum } from "../analysis/spectrum.js";
import { measurementsCreatedBy, summarize } from "./shared.js";

// The EQ settings endpoints (match-target-settings, default-room-curve-settings)
// are single objects: to change one field REW wants the whole object back, so read,
// merge the provided fields, write, and return the fresh state. With no fields this
// is a plain read. [LAW:one-source-of-truth] the read-merge-write lives once here.
async function readOrMergeSettings(
  client: RewClient,
  endpoint: string,
  settings: Record<string, unknown> | undefined,
): Promise<unknown> {
  if (settings !== undefined && Object.keys(settings).length > 0) {
    const current = (await client.get(endpoint, unknownSchema)) as Record<string, unknown>;
    await client.post(endpoint, { ...current, ...settings });
  }
  return client.get(endpoint, unknownSchema);
}

// The filters impulse response is an ImpulseResponse: metadata plus a base64 sample
// array. We surface metadata and a peak statistic, never the raw samples — the full
// array is hundreds of KB, too large for a tool result; the DSP-export flow owns that.
// When the measurement has no filters with an effect, REW answers { message } instead
// of an IR, so the two shapes are a discriminated union; the IR shape (with required
// `data`) is tried first, the sentinel falls through. [LAW:parse-dont-validate]
const impulseResponseSchema = z.looseObject({
  startTime: z.number().optional(),
  sampleInterval: z.number().optional(),
  sampleRate: z.number().optional(),
  data: z.string(),
});
const noIrDataSchema = z.looseObject({ message: z.string() });
const filtersIrSchema = z.union([impulseResponseSchema, noIrDataSchema]);

export const eqTools = [
  defineTool({
    name: "get_eq_filters",
    description:
      "Read the EQ filter bank REW holds for a measurement (type, frequency, gain, Q, enabled per filter).",
    inputSchema: { measurement: measurementIdInput },
    handler: async (client, args) =>
      client.get(`/measurements/${encodeURIComponent(args.measurement)}/filters`, filterListSchema),
  }),
  defineTool({
    name: "auto_eq",
    description:
      "Run REW's automatic EQ for a measurement: sets the equaliser model and target, matches the response to the target, and returns the generated filters plus a summary of the predicted corrected response. This is REW's own optimiser — the filters match what the REW GUI would produce.",
    inputSchema: {
      measurement: measurementIdInput,
      manufacturer: z
        .string()
        .default("Generic")
        .describe("Equaliser manufacturer as REW names it, e.g. 'Generic', 'MiniDSP'"),
      model: z
        .string()
        .default("Generic")
        .describe("Equaliser model as REW names it, e.g. 'Generic', '2x4 HD'"),
      targetLevelDb: z
        .number()
        .optional()
        .describe("Target level in dB SPL; omitted = let REW calculate it from the response"),
      shape: z
        .string()
        .optional()
        .describe("Target shape, e.g. 'Full range', 'Bass limited', 'Subwoofer', 'None'"),
      hpFreqHz: z.number().optional().describe("Target high-pass corner in Hz (with shape)"),
      hpSlopeDbPerOctave: z.number().optional().describe("Target high-pass slope, dB/octave"),
    },
    handler: async (client, args) => {
      const id = encodeURIComponent(args.measurement);
      await client.post(`/measurements/${id}/equaliser`, {
        manufacturer: args.manufacturer,
        model: args.model,
      });
      if (args.shape !== undefined) {
        await client.put(`/measurements/${id}/target-settings`, {
          shape: args.shape,
          lowFreqCutoffHz: args.hpFreqHz,
          lowFreqSlopedBPerOctave: args.hpSlopeDbPerOctave,
        });
      }
      if (args.targetLevelDb !== undefined) {
        await client.post(`/measurements/${id}/target-level`, args.targetLevelDb);
      } else {
        await client.command(`/measurements/${id}/eq/command`, { command: "Calculate target level" });
      }
      await client.command(`/measurements/${id}/eq/command`, { command: "Match target" });

      const filters = await client.get(`/measurements/${id}/filters`, filterListSchema);
      const predicted = await client.get(`/measurements/${id}/eq/frequency-response`, spectrumSchema, {
        ppo: 96,
      });
      const active = filters.filter((f) => f.enabled !== false && f.type !== undefined && f.type !== "None");
      return {
        filters: active,
        filterCount: active.length,
        predictedResponse: summarizeSpectrum(predicted.freqsHz, predicted.magDb),
      };
    },
  }),
  defineTool({
    name: "set_eq_filters",
    description:
      "Replace or update individual EQ filters on a measurement. Each entry is one filter slot; fields you omit keep their current value. Use get_eq_filters first to see the slots.",
    inputSchema: {
      measurement: measurementIdInput,
      filters: z
        .array(
          z.object({
            index: z.number().int().min(1).describe("1-based filter slot"),
            type: z.string().optional().describe("Filter type, e.g. 'PK', 'LS', 'HS', 'None'"),
            frequency: z.number().positive().optional().describe("Centre frequency, Hz"),
            gain: z.number().optional().describe("Gain, dB"),
            q: z.number().positive().optional().describe("Q factor"),
            enabled: z.boolean().optional(),
          }),
        )
        .min(1),
    },
    handler: async (client, args) => {
      const id = encodeURIComponent(args.measurement);
      for (const filter of args.filters) {
        await client.put(`/measurements/${id}/filters`, filter);
      }
      return client.get(`/measurements/${id}/filters`, filterListSchema);
    },
  }),
  defineTool({
    name: "get_predicted_response",
    description:
      "Summary of the predicted frequency response after applying the measurement's current EQ filters (REW's prediction, not a re-measurement).",
    inputSchema: { measurement: measurementIdInput },
    handler: async (client, args) => {
      const predicted = await client.get(
        `/measurements/${encodeURIComponent(args.measurement)}/eq/frequency-response`,
        spectrumSchema,
        { ppo: 96 },
      );
      return summarizeSpectrum(predicted.freqsHz, predicted.magDb);
    },
  }),
  defineTool({
    name: "list_equalisers",
    description: "List the equaliser hardware models REW can generate filters for.",
    inputSchema: {
      manufacturer: z.string().optional().describe("Filter to one manufacturer, e.g. 'miniDSP'"),
    },
    handler: async (client, args) =>
      client.get("/eq/equalisers", unknownSchema, { manufacturer: args.manufacturer }),
  }),
  defineTool({
    name: "house_curve",
    description:
      "Read, set, or clear REW's house curve — the target-shaping curve applied on top of the flat target (e.g. a gentle bass lift). action 'get' returns the current file path and log-interpolation flag; 'set' loads a curve file (logInterpolation is applied first, as REW requires); 'clear' removes it. Affects what auto_eq matches to.",
    inputSchema: {
      action: z.enum(["get", "set", "clear"]).describe("get the current curve, set a file, or clear it"),
      path: z.string().optional().describe("House curve file path (forward slashes) — required for 'set'"),
      logInterpolation: z
        .boolean()
        .optional()
        .describe("Interpolate the curve on a log-frequency axis (set with 'set', before the path)"),
    },
    handler: async (client, args) => {
      if (args.action === "set") {
        if (args.path === undefined || args.path.trim().length === 0) {
          // [LAW:no-silent-failure] 'set' with no path is a caller mistake — 'clear' removes.
          throw new Error("house_curve 'set' requires a 'path' (use action 'clear' to remove the curve)");
        }
        // Per REW: set the log-interpolation flag before the file path.
        if (args.logInterpolation !== undefined) {
          await client.post("/eq/house-curve-log-interpolation", args.logInterpolation);
        }
        await client.post("/eq/house-curve", args.path);
      }
      if (args.action === "clear") {
        await client.delete("/eq/house-curve");
      }
      return {
        path: await client.get("/eq/house-curve", unknownSchema),
        logInterpolation: await client.get("/eq/house-curve-log-interpolation", unknownSchema),
      };
    },
  }),
  defineTool({
    name: "get_target_response",
    description:
      "Read a measurement's EQ target as a log-spaced, decimated curve — what auto_eq is aiming the response at. Use this to explain why the optimiser chose the filters it did (compare it against get_frequency_response).",
    inputSchema: {
      measurement: measurementIdInput,
      maxPoints: z.number().int().min(10).max(500).default(120).describe("Maximum points (log-spaced)"),
    },
    handler: async (client, args) => {
      const target = await client.get(
        `/measurements/${encodeURIComponent(args.measurement)}/target-response`,
        spectrumSchema,
        { ppo: 96 },
      );
      const summary = summarizeSpectrum(target.freqsHz, target.magDb);
      return {
        unit: target.unit,
        rangeHz: summary.rangeHz,
        meanDb: summary.meanDb,
        points: decimateLog(target.freqsHz, target.magDb, args.maxPoints),
      };
    },
  }),
  defineTool({
    name: "eq_match_target_settings",
    description:
      "Read or change the settings REW's target matcher uses — max individual/overall boost, the flatness target, the match frequency range, and shelf-filter limits. Call with no settings to read them; provide any subset to change them (merged over the current values). These are the knobs auto_eq otherwise inherits silently from the GUI; set them before auto_eq for reproducible results. Field names come from the read (e.g. individualMaxBoostdB, overallMaxBoostdB, startFrequency, endFrequency, flatnessTargetdB).",
    inputSchema: {
      settings: z
        .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
        .optional()
        .describe('Fields to change, e.g. { "individualMaxBoostdB": 6, "overallMaxBoostdB": 0 }'),
    },
    handler: async (client, args) => readOrMergeSettings(client, "/eq/match-target-settings", args.settings),
  }),
  defineTool({
    name: "eq_room_curve_settings",
    description:
      "Read or change REW's default room-curve settings — the sloped target (bass rise / treble fall) added to the flat target. Call with no settings to read; provide any subset to change (merged over current). Fields include addRoomCurve, lowFreqRiseStartHz, lowFreqRiseSlopedBPerOctave, highFreqFallStartHz, highFreqFallSlopedBPerOctave.",
    inputSchema: {
      settings: z
        .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
        .optional()
        .describe('Fields to change, e.g. { "addRoomCurve": true, "lowFreqRiseSlopedBPerOctave": 1.0 }'),
    },
    handler: async (client, args) =>
      readOrMergeSettings(client, "/eq/default-room-curve-settings", args.settings),
  }),
  defineTool({
    name: "run_eq_command",
    description:
      "Run one of REW's EQ commands on a measurement: 'Optimise gains', 'Optimise gains and Qs', 'Optimise gains, Qs and Fcs' refine the current filters; 'Generate predicted measurement', 'Generate filters measurement', 'Generate target measurement' create a new measurement from the EQ result; 'Calculate target level' and 'Match target' are the auto_eq building blocks. Returns any measurement created and the resulting filter bank. Set the equaliser (auto_eq) first so filters exist to optimise.",
    inputSchema: {
      measurement: measurementIdInput,
      command: z
        .enum([
          "Calculate target level",
          "Match target",
          "Optimise gains",
          "Optimise gains and Qs",
          "Optimise gains, Qs and Fcs",
          "Generate predicted measurement",
          "Generate filters measurement",
          "Generate target measurement",
        ])
        .describe("EQ command to run (see /measurements/eq/commands)"),
    },
    handler: async (client, args) => {
      const id = encodeURIComponent(args.measurement);
      const { created } = await measurementsCreatedBy(client, () =>
        client.command(`/measurements/${id}/eq/command`, { command: args.command }),
      );
      return {
        command: args.command,
        created: created.map(summarize),
        filters: await client.get(`/measurements/${id}/filters`, filterListSchema),
      };
    },
  }),
  defineTool({
    name: "get_filters_impulse_response",
    description:
      "Render a measurement's EQ filter bank as an impulse response at a chosen sample rate and length — the basis for a convolution-DSP correction filter. Returns the IR metadata (sample rate, interval, length) and its peak sample, not the raw samples (which are large); the full export belongs to the DSP-export flow. Needs no measurement IR — just its filters.",
    inputSchema: {
      measurement: measurementIdInput,
      sampleRate: z.number().int().min(1).default(48000).describe("Sample rate of the rendered IR, Hz"),
      length: z
        .number()
        .int()
        .min(1)
        .max(4_194_304)
        .default(65536)
        .describe("IR length in samples (max 4,194,304)"),
    },
    handler: async (client, args) => {
      const ir = await client.get(
        `/measurements/${encodeURIComponent(args.measurement)}/filters-impulse-response`,
        filtersIrSchema,
        { samplerate: args.sampleRate, length: args.length },
      );
      if (typeof ir.data !== "string") {
        // [LAW:no-silent-failure] no effective filters is a real state to report.
        // (Both wire shapes are loose objects, so discriminate on the data field.)
        throw new Error(
          `no filter impulse response (REW: "${String(ir.message)}") — the measurement has no EQ ` +
            `filters that have an effect; set the equaliser and run auto_eq or add filters first`,
        );
      }
      const samples = decodeFloats(ir.data);
      let peak = 0;
      for (const s of samples) peak = Math.max(peak, Math.abs(s));
      return {
        sampleRate: ir.sampleRate,
        sampleIntervalSeconds: ir.sampleInterval,
        startTime: ir.startTime,
        numSamples: samples.length,
        peakSample: peak,
      };
    },
  }),
];
