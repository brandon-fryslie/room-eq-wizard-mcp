import { z } from "zod";
import { defineTool } from "./registry.js";
import type { RewClient } from "../rew/client.js";
import { unknownSchema } from "../rew/types.js";
import { measurementsCreatedBy, newestMeasurement, summarize } from "./shared.js";

// One preflight read of the measurement session's settings. timing-offset is
// omitted: REW 404s it unless a timing reference is selected, and a snapshot must
// not throw on the common (no-reference) case. [LAW:no-silent-failure]
async function readMeasureConfig(client: RewClient): Promise<Record<string, unknown>> {
  const read = (path: string) => client.get(path, unknownSchema);
  return {
    measurementMode: await read("/measure/measurement-mode"),
    numberOfRepetitions: await read("/measure/number-of-repetitions"),
    sweepRepetitions: await read("/measure/sweep/repetitions"),
    timingReference: await read("/measure/timing/reference"),
    playbackMode: await read("/measure/playback-mode"),
    captureNoiseFloor: await read("/measure/capture-noise-floor"),
    startDelaySeconds: await read("/measure/start-delay"),
    fillSilenceWithDither: await read("/measure/fill-silence-with-dither"),
    invertSecondOutput: await read("/measure/invert-second-output"),
    protectionOptions: await read("/measure/protection-options"),
  };
}

// The impedance measurement and its three calibration steps, by REW command name.
const IMPEDANCE_COMMANDS = {
  measure: "Impedance",
  "open-cal": "Impedance open cal",
  "short-cal": "Impedance short cal",
  "ref-cal": "Impedance ref cal",
} as const;

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
  defineTool({
    name: "get_measure_config",
    description:
      "Read REW's measurement-session settings in one call: measurement mode, sweep and per-session repetitions, timing reference, playback mode, noise-floor capture, start delay, dither, second-output inversion, and the protection options (clipping/SPL abort). Check before a serious measurement session.",
    inputSchema: {},
    handler: async (client) => readMeasureConfig(client),
  }),
  defineTool({
    name: "configure_measurement",
    description:
      "Configure a measurement session — timing reference, sweep/session repetitions, measurement mode (Single/Repeated/Sequential/Ramped) with its sequential channel list and ramp start/end levels, playback mode and file-playback stimulus, noise-floor capture, start delay, dither, and second-output inversion. Applies whichever fields are provided and returns the resulting config. Use set_measurement_protection for clipping/SPL abort limits. Requires a REW Pro license (the /measure write actions are Pro-gated).",
    inputSchema: {
      measurementMode: z
        .enum(["Single", "Repeated", "Sequential", "Ramped"])
        .optional()
        .describe("Measurement mode. Repeated/Ramped use numberOfRepetitions; Sequential uses sequentialChannels"),
      sweepRepetitions: z.number().int().min(1).optional().describe("Number of sweep repetitions per measurement"),
      numberOfRepetitions: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Measurements made in Repeated/Ramped mode with REW playback"),
      timingReference: z
        .string()
        .optional()
        .describe("Timing reference, e.g. 'None', 'Acoustic', 'Loopback' (see REW for the valid set)"),
      timingOffsetSeconds: z
        .number()
        .optional()
        .describe("Timing offset in seconds — only valid when a timing reference is selected"),
      playbackMode: z.string().optional().describe("Playback mode, e.g. 'From REW' or 'From file'"),
      filePlaybackStimulus: z
        .string()
        .optional()
        .describe("Path to the stimulus file (forward slashes), for 'From file' playback mode"),
      captureNoiseFloor: z.boolean().optional().describe("Capture the noise floor before an SPL measurement"),
      startDelaySeconds: z.number().min(0).optional().describe("Delay in seconds before a measurement starts"),
      fillSilenceWithDither: z.boolean().optional().describe("Fill silent output with 16-bit dither"),
      invertSecondOutput: z.boolean().optional().describe("Invert the second output when driving two outputs"),
      sequentialChannels: z
        .array(z.string())
        .min(1)
        .optional()
        .describe("Channels to measure in Sequential mode, e.g. ['L','R'] (see /measure/sequential-choices)"),
      rampStartLevelDbfs: z.number().max(0).optional().describe("Start level for Ramped mode, dBFS"),
      rampEndLevelDbfs: z.number().max(0).optional().describe("End level for Ramped mode, dBFS"),
    },
    handler: async (client, args) => {
      // [LAW:dataflow-not-control-flow] a fixed table of setting → endpoint → body;
      // the data (which fields are defined) decides which writes carry a change, and
      // the write loop is the same every call. Most endpoints take a bare scalar; the
      // ramp levels take REW's {value, unit} level shape.
      const writes: Array<[unknown, string, unknown]> = [
        [args.measurementMode, "/measure/measurement-mode", args.measurementMode],
        [args.sweepRepetitions, "/measure/sweep/repetitions", args.sweepRepetitions],
        [args.numberOfRepetitions, "/measure/number-of-repetitions", args.numberOfRepetitions],
        [args.timingReference, "/measure/timing/reference", args.timingReference],
        [args.timingOffsetSeconds, "/measure/timing-offset", args.timingOffsetSeconds],
        [args.playbackMode, "/measure/playback-mode", args.playbackMode],
        [args.filePlaybackStimulus, "/measure/file-playback-stimulus", args.filePlaybackStimulus],
        [args.captureNoiseFloor, "/measure/capture-noise-floor", args.captureNoiseFloor],
        [args.startDelaySeconds, "/measure/start-delay", args.startDelaySeconds],
        [args.fillSilenceWithDither, "/measure/fill-silence-with-dither", args.fillSilenceWithDither],
        [args.invertSecondOutput, "/measure/invert-second-output", args.invertSecondOutput],
        [args.sequentialChannels, "/measure/sequential-channels", args.sequentialChannels],
        [args.rampStartLevelDbfs, "/measure/start-level", { value: args.rampStartLevelDbfs, unit: "dBFS" }],
        [args.rampEndLevelDbfs, "/measure/end-level", { value: args.rampEndLevelDbfs, unit: "dBFS" }],
      ];
      const applied = writes.filter(([value]) => value !== undefined);
      if (applied.length === 0) {
        // [LAW:no-silent-failure] a no-op configure is a caller mistake, not success.
        throw new Error("provide at least one measurement setting to change (see get_measure_config)");
      }
      for (const [, endpoint, body] of applied) await client.post(endpoint, body);
      return readMeasureConfig(client);
    },
  }),
  defineTool({
    name: "set_measurement_protection",
    description:
      "Set REW's measurement protection — abort a measurement on heavy input clipping or when SPL exceeds a limit — plus the low-level/distortion/SNR warnings. This is the safety layer for measurement: set clippingAbort and an splLimitAbort/dBSPLLimit before letting a novice drive a sweep. Applies the provided fields over the current options and returns the result. Requires a REW Pro license.",
    inputSchema: {
      clippingAbort: z.boolean().optional().describe("Abort the measurement if heavy input clipping is detected"),
      splLimitAbort: z.boolean().optional().describe("Abort the measurement if SPL exceeds dBSPLLimit"),
      dBSPLLimit: z.number().optional().describe("SPL limit in dB for splLimitAbort, e.g. 100"),
      warnForLowLevels: z.boolean().optional().describe("Warn on low input levels"),
      warnForHighDistortion: z.boolean().optional().describe("Warn on high distortion"),
      warnForLowSNR: z.boolean().optional().describe("Warn on low signal-to-noise ratio"),
    },
    handler: async (client, args) => {
      const provided = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined));
      if (Object.keys(provided).length === 0) {
        // [LAW:no-silent-failure] a no-op is a caller mistake, not success.
        throw new Error("provide at least one protection option to change (see get_measure_config)");
      }
      // Merge over the current options so unspecified protections are preserved.
      const current = (await client.get("/measure/protection-options", unknownSchema)) as Record<string, unknown>;
      await client.post("/measure/protection-options", { ...current, ...provided });
      return client.get("/measure/protection-options", unknownSchema);
    },
  }),
  defineTool({
    name: "measure_impedance",
    description:
      "Run an impedance measurement, or a jig calibration step for one. step 'measure' (default) runs the impedance sweep and returns the new measurement; 'open-cal', 'short-cal', and 'ref-cal' run the corresponding impedance calibration and return REW's result. Requires an impedance measurement jig connected per REW's impedance setup, and a REW Pro license.",
    inputSchema: {
      step: z
        .enum(["measure", "open-cal", "short-cal", "ref-cal"])
        .default("measure")
        .describe("'measure' takes the impedance measurement; the '*-cal' steps calibrate the jig"),
    },
    handler: async (client, args) => {
      const command = IMPEDANCE_COMMANDS[args.step];
      if (args.step !== "measure") {
        // Calibration steps configure the jig; they do not create a measurement.
        const result = await client.command("/measure/command", { command });
        return { step: args.step, result: result ?? `${command} completed` };
      }
      const { created } = await measurementsCreatedBy(client, () =>
        client.command("/measure/command", { command }),
      );
      if (created.length === 0) {
        // [LAW:no-silent-failure] an impedance measurement must produce a measurement.
        throw new Error(
          "impedance measurement produced no measurement — check the impedance jig and calibration",
        );
      }
      return { step: "measure", measurement: summarize(created[created.length - 1]) };
    },
  }),
];
