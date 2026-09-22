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
      // Wire field names, verified live: showSPL/splWeighting, NOT mode/weighting.
      // REW merges a partial POST and answers "Configuration processed" while
      // silently dropping keys it does not know, so a wrong name here is invisible —
      // which is exactly how this tool spent its life reading A-weighted levels
      // while reporting the C the caller asked for.
      await client.post(`${meter}/configuration`, {
        showSPL: true,
        splWeighting: args.weighting,
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
      // The reading reports the weighting it was actually taken with, so the request
      // is checked against the result for free. [LAW:no-silent-failure] REW drops
      // unknown config keys without complaint; this is what turns that silence into
      // an error instead of a mislabelled number. A REW that does not report the
      // weighting at all leaves nothing to contradict, so nothing is claimed.
      if (levels.splWeighting !== undefined && levels.splWeighting !== args.weighting) {
        throw new Error(
          `Asked for ${args.weighting}-weighting but the meter read ${levels.splWeighting} — ` +
            `REW did not accept the configuration, so this level is not the one you asked for`,
        );
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
