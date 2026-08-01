import { z } from "zod";
import { defineTool } from "./registry.js";
import { newestMeasurement, summarize } from "./shared.js";

export const measureTools = [
  defineTool({
    name: "run_sweep",
    description:
      "Configure and run a swept-sine SPL measurement. Requires REW's audio input/output to be configured and a REW Pro license for API-triggered measurement. Blocks until the sweep completes and returns the new measurement.",
    inputSchema: {
      startFreqHz: z.number().min(1).default(20).describe("Sweep start frequency, Hz"),
      endFreqHz: z.number().min(10).default(20000).describe("Sweep end frequency, Hz"),
      length: z
        .enum(["128k", "256k", "512k", "1M"])
        .default("256k")
        .describe("Sweep length in samples — longer is slower but higher signal-to-noise"),
      name: z.string().optional().describe("Name for the new measurement"),
      notes: z.string().optional().describe("Notes stored with the new measurement"),
      levelDbfs: z
        .number()
        .max(0)
        .optional()
        .describe("Output level in dBFS (e.g. -12). Left unchanged when omitted."),
    },
    handler: async (client, args) => {
      if (args.endFreqHz <= args.startFreqHz) {
        throw new Error(`endFreqHz (${args.endFreqHz}) must be above startFreqHz (${args.startFreqHz})`);
      }
      await client.post("/measure/sweep/configuration", {
        startFrequency: args.startFreqHz,
        endFrequency: args.endFreqHz,
        length: args.length,
      });
      if (args.name !== undefined) {
        await client.post("/measure/naming", { title: args.name, namingOption: "Use as entered" });
      }
      if (args.notes !== undefined) {
        await client.post("/measure/notes", args.notes);
      }
      if (args.levelDbfs !== undefined) {
        await client.post("/measure/level", { value: args.levelDbfs, unit: "dBFS" });
      }
      await client.command("/measure/command", { command: "SPL" });
      const created = await newestMeasurement(client);
      return {
        completed: true,
        measurement: created !== null ? summarize(created) : null,
      };
    },
  }),
];
