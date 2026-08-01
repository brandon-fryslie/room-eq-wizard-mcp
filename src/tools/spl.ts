import { z } from "zod";
import { defineTool } from "./registry.js";
import { splValuesSchema } from "../rew/types.js";

export const splTools = [
  defineTool({
    name: "read_spl",
    description:
      "Read the current sound pressure level from REW's SPL meter (SPL, Leq, SEL). Starts the meter, waits for it to integrate, reads, and optionally stops it. Play a signal (see the generator tool) to measure playback level.",
    inputSchema: {
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
      await client.post("/spl-meter/1/configuration", {
        mode: "SPL",
        weighting: args.weighting,
        filter: args.filter,
      });
      await client.post("/spl-meter/1/command", { command: "Start" });
      // [LAW:no-ambient-temporal-coupling] the settle time is the meter's own
      // integration window — a named, caller-controlled parameter, not a magic sleep.
      await new Promise((resolve) => setTimeout(resolve, args.settleSeconds * 1000));
      const levels = await client.get("/spl-meter/1/levels", splValuesSchema);
      if (args.stopAfter) {
        await client.post("/spl-meter/1/command", { command: "Stop" });
      }
      return levels;
    },
  }),
];
