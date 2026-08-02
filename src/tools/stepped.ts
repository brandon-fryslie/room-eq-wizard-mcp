// REW's stepped measurement: THD/IMD vs frequency or level — driver and amp
// distortion characterisation, the studio-designer end of the spectrum. Select a
// type, set the frequency/level span and FFT/options, start (per-type stimulus),
// then poll progress. Distortion results stream to subscribers (not wrapped here).

import { z } from "zod";
import { defineTool } from "./registry.js";
import type { RewClient } from "../rew/client.js";
import { unknownSchema } from "../rew/types.js";
import { writeMergedSettings } from "./shared.js";

async function readSteppedConfig(client: RewClient): Promise<Record<string, unknown>> {
  const read = (path: string) => client.get(path, unknownSchema);
  const [types, type, frequencySpan, levelSpan, fftConfiguration, options] = await Promise.all([
    read("/stepped-measurement/types"),
    read("/stepped-measurement/type"),
    read("/stepped-measurement/frequency-span"),
    read("/stepped-measurement/level-span"),
    read("/stepped-measurement/fft-configuration"),
    read("/stepped-measurement/options"),
  ]);
  return { types, type, frequencySpan, levelSpan, fftConfiguration, options };
}

const settingsRecord = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));

const STEPPED_CONTROL = {
  stop: "Stop",
  cancel: "Cancel",
  pause: "Pause",
  resume: "Resume",
  back: "Back",
} as const;

export const steppedTools = [
  defineTool({
    name: "get_stepped_config",
    description:
      "Read REW's stepped-measurement setup in one call: the available measurement types and the selected one (THD vs frequency/level, IMD vs level, Multitone TD+N), the frequency span, level span, FFT configuration, and options (clipping/distortion stop limits, spectrum capture).",
    inputSchema: {},
    handler: async (client) => readSteppedConfig(client),
  }),
  defineTool({
    name: "configure_stepped",
    description:
      "Configure a stepped distortion measurement: the type ('THD vs frequency', 'THD vs level', 'THD vs frequency & level', 'IMD vs level', 'Multitone TD+N vs level'), the frequency span (startFreq/endFreq/ppo), level span (startLevel/endLevel/step, dBFS), FFT configuration (fftLength/averages/window), and options (stopForHeavyClipping, stopAtDistortionLimit, distortionLimitPercent…). Applies whichever are provided and returns the resulting config.",
    inputSchema: {
      type: z
        .enum([
          "THD vs frequency",
          "THD vs level",
          "THD vs frequency & level",
          "IMD vs level",
          "Multitone TD+N vs level",
        ])
        .optional()
        .describe("Measurement type to select"),
      frequencySpan: settingsRecord
        .optional()
        .describe('Frequency span fields, e.g. { "startFreq": 20, "endFreq": 20000, "ppo": 3 }'),
      levelSpan: settingsRecord
        .optional()
        .describe('Level span fields (dBFS), e.g. { "startLevel": -60, "endLevel": 0, "step": 5 }'),
      fftConfiguration: settingsRecord
        .optional()
        .describe('FFT config fields, e.g. { "fftLength": "64k", "averages": 2 }'),
      options: settingsRecord
        .optional()
        .describe('Options, e.g. { "stopAtDistortionLimit": true, "distortionLimitPercent": 1.0 }'),
    },
    handler: async (client, args) => {
      // Count real changes: a defined type, or a sub-object with at least one key.
      // An empty sub-object (e.g. frequencySpan: {}) writes nothing, so it is a no-op.
      // [LAW:no-silent-failure] reject it rather than silently doing nothing.
      const records = [args.frequencySpan, args.levelSpan, args.fftConfiguration, args.options];
      const hasChange =
        args.type !== undefined || records.some((r) => r !== undefined && Object.keys(r).length > 0);
      if (!hasChange) {
        throw new Error("provide at least one stepped-measurement setting to change (see get_stepped_config)");
      }
      if (args.type !== undefined) await client.post("/stepped-measurement/type", args.type);
      await writeMergedSettings(client, "/stepped-measurement/frequency-span", args.frequencySpan);
      await writeMergedSettings(client, "/stepped-measurement/level-span", args.levelSpan);
      await writeMergedSettings(client, "/stepped-measurement/fft-configuration", args.fftConfiguration);
      await writeMergedSettings(client, "/stepped-measurement/options", args.options);
      return readSteppedConfig(client);
    },
  }),
  defineTool({
    name: "start_stepped_measurement",
    description:
      "Start the configured stepped measurement. Requires a settling time and the stimulus parameter that matches the selected type: frequencyHz for '…vs level' types, levelDbfs for '…vs frequency' types, or imdStimulus for IMD. Requires REW's audio output to be configured. Returns the initial progress; poll get_stepped_progress for completion.",
    inputSchema: {
      settlingTimeMs: z.number().min(0).default(100).describe("Settling time before each point, ms"),
      frequencyHz: z.number().positive().optional().describe("Stimulus frequency (for '…vs level' measurements)"),
      levelDbfs: z.number().max(0).optional().describe("Stimulus level in dBFS (for '…vs frequency' measurements)"),
      imdStimulus: z.string().optional().describe("IMD stimulus specifier (for IMD measurements)"),
    },
    handler: async (client, args) => {
      // Exactly one stimulus — the one that matches the selected type. Zero is a
      // missing arg; more than one is ambiguous (REW takes a single stimulus).
      // [LAW:no-silent-failure] fail clearly here rather than sending a confused body.
      const stimuli = [args.frequencyHz, args.levelDbfs, args.imdStimulus].filter((v) => v !== undefined);
      if (stimuli.length !== 1) {
        throw new Error(
          "provide exactly one stimulus for Start: frequencyHz (…vs level), levelDbfs (…vs frequency), or imdStimulus (IMD)",
        );
      }
      const body: Record<string, unknown> = { command: "Start", settlingTimems: args.settlingTimeMs };
      if (args.frequencyHz !== undefined) body.frequencyHz = args.frequencyHz;
      if (args.levelDbfs !== undefined) body.leveldBFS = args.levelDbfs;
      if (args.imdStimulus !== undefined) body.imdStimulus = args.imdStimulus;
      await client.post("/stepped-measurement/command", body);
      return { started: true, progress: await client.get("/stepped-measurement/progress", unknownSchema) };
    },
  }),
  defineTool({
    name: "control_stepped_measurement",
    description:
      "Control a running stepped measurement: 'stop' finishes early keeping results, 'cancel' abandons it, 'pause'/'resume' hold and continue, 'back' steps to the previous point. Returns the resulting progress.",
    inputSchema: {
      action: z.enum(["stop", "cancel", "pause", "resume", "back"]).describe("Control action"),
    },
    handler: async (client, args) => {
      await client.post("/stepped-measurement/command", { command: STEPPED_CONTROL[args.action] });
      return client.get("/stepped-measurement/progress", unknownSchema);
    },
  }),
  defineTool({
    name: "get_stepped_progress",
    description:
      "Read the progress of a stepped measurement — the current point, total points, and a status message. Poll this after start_stepped_measurement until it completes.",
    inputSchema: {},
    handler: async (client) => client.get("/stepped-measurement/progress", unknownSchema),
  }),
];
