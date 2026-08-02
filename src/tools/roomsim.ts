// REW's room simulator: measurement-free what-if analysis. Set the room geometry,
// surface absorptions, and source positions, then read the predicted frequency
// response at a mic position — "would moving the sub fix that 42 Hz peak" answered
// by simulation, before you measure. src/analysis/room-modes.ts is the offline
// fallback (bare mode frequencies); this is the positioned-source SPL prediction.

import { z } from "zod";
import { defineTool } from "./registry.js";
import type { RewClient } from "../rew/client.js";
import { spectrumSchema, unknownSchema } from "../rew/types.js";
import { decimateLog, summarizeSpectrum } from "../analysis/spectrum.js";
import { readMergeWriteSettings } from "./shared.js";

async function readRoomsimConfig(client: RewClient): Promise<Record<string, unknown>> {
  const read = (path: string) => client.get(path, unknownSchema);
  const [roomSize, sealed, absorptions, sources, micOffsets, options] = await Promise.all([
    read("/roomsim/room-size"),
    read("/roomsim/room-is-sealed"),
    read("/roomsim/absorptions"),
    read("/roomsim/sources"),
    read("/roomsim/mic-posn-offsets"),
    read("/roomsim/options"),
  ]);
  return { roomSize, sealed, absorptions, sources, micOffsets, options };
}

const settingsRecord = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));

export const roomsimTools = [
  defineTool({
    name: "get_roomsim_config",
    description:
      "Read REW's room simulator setup in one call: room size, sealed flag, surface absorptions, the source list, mic-position offsets, and calculation options (crossover, time-align, etc.). The what-if baseline you adjust before reading a simulated response.",
    inputSchema: {},
    handler: async (client) => readRoomsimConfig(client),
  }),
  defineTool({
    name: "configure_roomsim",
    description:
      "Set up the room simulation: room dimensions (metres), whether the room is sealed, surface absorptions (front/back/left/right/ceiling/floor, 0–1), mic-position offsets, and calculation options (e.g. useCrossoverFilter, crossoverFrequencyHz, timeAlignSpeakersAndSubs). Applies whichever fields are provided and returns the resulting config.",
    inputSchema: {
      lengthM: z.number().positive().optional().describe("Room length, metres"),
      widthM: z.number().positive().optional().describe("Room width, metres"),
      heightM: z.number().positive().optional().describe("Room height, metres"),
      sealed: z.boolean().optional().describe("Treat the room as a sealed volume"),
      absorptions: settingsRecord
        .optional()
        .describe('Surface absorptions to change, e.g. { "front": 0.2, "floor": 0.05 } (0–1)'),
      micOffsets: settingsRecord.optional().describe("Mic-position offset fields to change (metres)"),
      options: settingsRecord
        .optional()
        .describe('Calc options, e.g. { "useCrossoverFilter": true, "crossoverFrequencyHz": 80 }'),
    },
    handler: async (client, args) => {
      const dims = { lengthM: "length", widthM: "width", heightM: "height" } as const;
      const dimChanges = Object.entries(dims).filter(([k]) => args[k as keyof typeof dims] !== undefined);
      if (dimChanges.length > 0) {
        // z.looseObject throws on a non-object, so the dim merge can't spread garbage.
        const current = await client.get("/roomsim/room-size", z.looseObject({}));
        const next: Record<string, unknown> = { ...current };
        for (const [argKey, wireKey] of dimChanges) next[wireKey] = args[argKey as keyof typeof dims];
        await client.post("/roomsim/room-size", next);
      }
      if (args.sealed !== undefined) await client.post("/roomsim/room-is-sealed", args.sealed);
      if (args.absorptions !== undefined) {
        await readMergeWriteSettings(client, "/roomsim/absorptions", args.absorptions);
      }
      if (args.micOffsets !== undefined) {
        await readMergeWriteSettings(client, "/roomsim/mic-posn-offsets", args.micOffsets);
      }
      if (args.options !== undefined) {
        await readMergeWriteSettings(client, "/roomsim/options", args.options);
      }
      if (Object.values(args).every((v) => v === undefined)) {
        // [LAW:no-silent-failure] a no-op configure is a caller mistake, not success.
        throw new Error("provide at least one room-sim setting to change (see get_roomsim_config)");
      }
      return readRoomsimConfig(client);
    },
  }),
  defineTool({
    name: "set_roomsim_source",
    description:
      "Position and configure one simulation source (a speaker or sub, e.g. 'Sub1', 'Left'; see get_roomsim_config's source list / /roomsim/source-names). Set its position (fromRear/fromLeft/fromFloor, metres) and/or configuration (lfMinus3dBHz, enclosureType, invert, delayms, gaindB). Returns the source's resulting position and configuration.",
    inputSchema: {
      source: z.string().min(1).describe("Source name, e.g. 'Sub1', 'Left', 'Right'"),
      position: settingsRecord
        .optional()
        .describe('Position fields to change, e.g. { "fromRear": 4.7, "fromLeft": 0.15, "fromFloor": 0.15 }'),
      configuration: settingsRecord
        .optional()
        .describe('Config fields to change, e.g. { "lfMinus3dBHz": 30, "enclosureType": "Ported" }'),
    },
    handler: async (client, args) => {
      const src = encodeURIComponent(args.source);
      if (args.position === undefined && args.configuration === undefined) {
        // [LAW:no-silent-failure] nothing to change is a caller mistake.
        throw new Error("provide position and/or configuration to change for the source");
      }
      if (args.position !== undefined) {
        await readMergeWriteSettings(client, `/roomsim/${src}/position`, args.position);
      }
      if (args.configuration !== undefined) {
        await readMergeWriteSettings(client, `/roomsim/${src}/configuration`, args.configuration);
      }
      return {
        source: args.source,
        position: await client.get(`/roomsim/${src}/position`, unknownSchema),
        configuration: await client.get(`/roomsim/${src}/configuration`, unknownSchema),
      };
    },
  }),
  defineTool({
    name: "get_roomsim_response",
    description:
      "Read the simulated frequency response at a mic position — all sources summed, or one source alone — as a decimated curve plus summary statistics (peaks/nulls are the predicted room modes). This is the what-if payoff: change a source position with set_roomsim_source, then read the predicted response here.",
    inputSchema: {
      source: z
        .string()
        .min(1)
        .optional()
        .describe("A single source to read alone; omit for all sources summed"),
      micPosition: z
        .string()
        .default("Main")
        .describe("Mic position: 'Main', 'To left', 'To right', 'In front', 'Behind', 'Above', 'Below'"),
      maxPoints: z.number().int().min(10).max(500).default(120).describe("Maximum points (log-spaced)"),
    },
    handler: async (client, args) => {
      const endpoint =
        args.source !== undefined
          ? `/roomsim/${encodeURIComponent(args.source)}/frequency-response`
          : "/roomsim/frequency-response";
      const spectrum = await client.get(endpoint, spectrumSchema, { micposition: args.micPosition });
      const summary = summarizeSpectrum(spectrum.freqsHz, spectrum.magDb);
      return {
        source: args.source ?? "all sources summed",
        micPosition: args.micPosition,
        unit: spectrum.unit,
        rangeHz: summary.rangeHz,
        meanDb: summary.meanDb,
        peaks: summary.peaks,
        nulls: summary.nulls,
        points: decimateLog(spectrum.freqsHz, spectrum.magDb, args.maxPoints),
      };
    },
  }),
];
