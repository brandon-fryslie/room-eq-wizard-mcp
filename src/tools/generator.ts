import { z } from "zod";
import { defineTool } from "./registry.js";
import { unknownSchema } from "../rew/types.js";

export const generatorTools = [
  defineTool({
    name: "generator",
    description:
      "Control REW's signal generator. Applies whichever settings are provided (signal, level, frequency), then optionally starts or stops playback. Call with only { play: true } / { play: false } to toggle playback of the current signal.",
    inputSchema: {
      signal: z
        .string()
        .optional()
        .describe("Signal to select, e.g. 'Pink noise', 'Sine', 'White noise', 'Sweep' (see /generator/signals via REW)"),
      levelDbfs: z.number().max(0).optional().describe("Output level in dBFS, e.g. -12"),
      frequencyHz: z
        .number()
        .positive()
        .optional()
        .describe("Frequency in Hz — only valid for signals that have one (Sine, tones)"),
      play: z
        .boolean()
        .optional()
        .describe("true to start playback, false to stop; omit to leave playback state unchanged"),
    },
    handler: async (client, args) => {
      // [LAW:dataflow-not-control-flow] each provided value flows to its endpoint;
      // the set of operations is fixed, the data decides what they carry.
      if (args.signal !== undefined) {
        // REW's signal endpoint expects the lowercase, space-stripped form of the name.
        await client.post("/generator/signal", {
          signal: args.signal.toLowerCase().replaceAll(" ", ""),
        });
      }
      if (args.levelDbfs !== undefined) {
        await client.post("/generator/level", { value: args.levelDbfs, unit: "dBFS" });
      }
      if (args.frequencyHz !== undefined) {
        await client.post("/generator/frequency", { value: args.frequencyHz, unit: "Hz" });
      }
      if (args.play !== undefined) {
        await client.post("/generator/command", { command: args.play ? "Play" : "Stop" });
      }
      return client.get("/generator/status", unknownSchema);
    },
  }),
];
