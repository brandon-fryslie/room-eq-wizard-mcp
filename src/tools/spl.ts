import { z } from "zod";
import { defineTool } from "./registry.js";
import { splValuesSchema } from "../rew/types.js";
import { readMergeWriteSettings } from "./shared.js";

const meterNumber = z
  .number()
  .int()
  .min(1)
  .max(4)
  .default(1)
  .describe("SPL meter number (1–4; meters 2–4 need a REW Pro licence)");

export const splTools = [
  defineTool({
    name: "read_spl",
    description:
      "Read the current sound pressure level from a REW SPL meter (SPL, Leq, SEL). Starts the meter, waits for it to integrate, reads, and optionally stops it. Play a signal (see the generator tool) to measure playback level.",
    inputSchema: {
      meterNumber,
      weighting: z
        .enum(["A", "C", "Z"])
        .default("C")
        .describe("Frequency weighting — C is usual for speaker calibration"),
      filter: z.enum(["Fast", "Slow"]).default("Slow").describe("Time weighting"),
      settleSeconds: z
        .number()
        .min(0)
        .max(30)
        .default(2)
        .describe("Seconds to let the meter integrate before reading"),
      stopAfter: z.boolean().default(true).describe("Stop the meter after reading"),
    },
    handler: async (client, args) => {
      const meter = `/spl-meter/${args.meterNumber}`;
      await client.post(`${meter}/configuration`, {
        mode: "SPL",
        weighting: args.weighting,
        filter: args.filter,
      });
      await client.post(`${meter}/command`, { command: "Start" });
      // [LAW:no-ambient-temporal-coupling] the settle time is the meter's own
      // integration window — a named, caller-controlled parameter, not a magic sleep.
      await new Promise((resolve) => setTimeout(resolve, args.settleSeconds * 1000));
      const levels = await client.get(`${meter}/levels`, splValuesSchema);
      if (args.stopAfter) {
        await client.post(`${meter}/command`, { command: "Stop" });
      }
      return levels;
    },
  }),
  defineTool({
    name: "spl_meter_config",
    description:
      "Read or change an SPL meter's configuration: which of SPL/Leq/SEL to show, per-measure weightings, time filter, high-pass, and the rolling Leq — a running average of level over the last rollingLeqMinutes (e.g. 'average listening level over the last 15 minutes'). Call with only meterNumber to read; provide any field to change it.",
    inputSchema: {
      meterNumber,
      showSPL: z.boolean().optional(),
      showLeq: z.boolean().optional(),
      showSEL: z.boolean().optional(),
      splWeighting: z.enum(["A", "C", "Z"]).optional().describe("SPL frequency weighting"),
      leqWeighting: z.enum(["A", "C", "Z"]).optional().describe("Leq frequency weighting"),
      filter: z.enum(["Fast", "Slow"]).optional().describe("Time weighting"),
      highPassActive: z.boolean().optional().describe("Apply the meter's high-pass filter"),
      rollingLeqActive: z.boolean().optional().describe("Use a rolling (windowed) Leq"),
      rollingLeqMinutes: z.number().positive().optional().describe("Rolling Leq window length, minutes"),
    },
    handler: async (client, args) => {
      const { meterNumber: n, ...fields } = args;
      const provided = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
      return readMergeWriteSettings(
        client,
        `/spl-meter/${n}/configuration`,
        Object.keys(provided).length > 0 ? provided : undefined,
      );
    },
  }),
];
