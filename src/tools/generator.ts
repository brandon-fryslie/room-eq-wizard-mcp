import { z } from "zod";
import { defineTool } from "./registry.js";
import type { RewClient } from "../rew/client.js";
import { unknownSchema } from "../rew/types.js";
import { readMergeWriteSettings } from "./shared.js";

export const generatorTools = [
  defineTool({
    name: "generator",
    description:
      "Control REW's signal generator. Applies whichever settings are provided (signal, level, frequency, second-output inversion), then optionally starts or stops playback. Call with only { play: true } / { play: false } to toggle playback of the current signal. Discover signal names with list_generator_signals.",
    inputSchema: {
      signal: z
        .string()
        .optional()
        .describe("Signal to select, e.g. 'Pink noise', 'Sine', 'White noise' (see list_generator_signals)"),
      levelDbfs: z.number().max(0).optional().describe("Output level in dBFS, e.g. -12"),
      frequencyHz: z
        .number()
        .positive()
        .optional()
        .describe("Frequency in Hz — only valid for signals that have one (Sine, tones)"),
      invertSecondOutput: z
        .boolean()
        .optional()
        .describe("Invert the second output (for balanced/dual-output drive)"),
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
      if (args.invertSecondOutput !== undefined) {
        await client.post("/generator/invert-second-output", args.invertSecondOutput);
      }
      if (args.play !== undefined) {
        await client.post("/generator/command", { command: args.play ? "Play" : "Stop" });
      }
      return client.get("/generator/status", unknownSchema);
    },
  }),
  defineTool({
    name: "list_generator_signals",
    description:
      "List the signal names REW's generator can produce (sine, pinknoise, multitone, toneburst, j-test…). Feed a name to the generator tool's 'signal' field.",
    inputSchema: {},
    handler: async (client) => client.get("/generator/signals", unknownSchema),
  }),
  defineTool({
    name: "set_generator_protection",
    description:
      "Set the generator's playback protection — abort on heavy output clipping (clippingAbort) or when SPL exceeds a limit (splLimitAbort + dBSPLLimit). The safety layer for playing test signals: set these before a playbook plays anything loud. Call with no fields to read the current settings.",
    inputSchema: {
      clippingAbort: z.boolean().optional().describe("Abort playback on heavy output clipping"),
      splLimitAbort: z.boolean().optional().describe("Abort playback if SPL exceeds dBSPLLimit"),
      dBSPLLimit: z.number().optional().describe("SPL limit in dB for splLimitAbort, e.g. 100"),
    },
    handler: async (client: RewClient, args) => {
      const provided = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined));
      return readMergeWriteSettings(
        client,
        "/generator/protection",
        Object.keys(provided).length > 0 ? provided : undefined,
      );
    },
  }),
];
