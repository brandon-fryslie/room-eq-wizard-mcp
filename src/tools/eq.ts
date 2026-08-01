import { z } from "zod";
import { defineTool, measurementIdInput } from "./registry.js";
import { filterListSchema, spectrumSchema, unknownSchema } from "../rew/types.js";
import { summarizeSpectrum } from "../analysis/spectrum.js";

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
];
