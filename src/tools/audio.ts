// The preflight layer: REW's audio device/driver/sample-rate selection, mic
// calibration, and live input-level monitoring. Without these the model cannot
// verify the mic is heard, unclipped, and calibrated before a measurement — a
// silent-degradation risk for every downstream insight. Both sweep and RTA need it.
//
// Driver split: on macOS the only driver is Java and its device/input/channel
// sub-resources live under /audio/java/*; REW 404s those paths under the ASIO
// (Windows) driver. So the per-driver device block is read only for the driver in
// use, and the driver value itself is always reported. [LAW:no-silent-failure]

import { z } from "zod";
import { defineTool } from "./registry.js";
import type { RewClient } from "../rew/client.js";
import { unknownSchema, wireNumberSchema } from "../rew/types.js";

// Reading input-cal to change one field means round-tripping the whole structure,
// so it needs a shape loose enough to preserve REW's other fields untouched.
const inputCalSchema = z.looseObject({
  calDataAllInputs: z.looseObject({}).optional(),
});

/** The Java driver's device/input/output selection — only valid under that driver. */
async function readJavaDevices(client: RewClient): Promise<Record<string, unknown>> {
  return {
    inputDevice: await client.get("/audio/java/input-device", unknownSchema),
    input: await client.get("/audio/java/input", unknownSchema),
    inputChannel: await client.get("/audio/java/input-channel", unknownSchema),
    numInputChannels: await client.get("/audio/java/num-input-channels", wireNumberSchema),
    outputDevice: await client.get("/audio/java/output-device", unknownSchema),
    output: await client.get("/audio/java/output", unknownSchema),
  };
}

/** One preflight snapshot: driver, sample rate, device selection, and both cals. */
async function readAudioConfig(client: RewClient): Promise<Record<string, unknown>> {
  const driver = await client.get("/audio/driver", z.looseObject({ driver: z.string().optional() }));
  const common = {
    driver: driver.driver,
    sampleRate: await client.get("/audio/samplerate", unknownSchema),
    inputCal: await client.get("/audio/input-cal", unknownSchema),
    outputCal: await client.get("/audio/output-cal", unknownSchema),
  };
  // [LAW:dataflow-not-control-flow] the driver value decides which device block
  // exists; a non-Java driver reports why the block is absent rather than 404ing.
  const devices =
    driver.driver === "Java"
      ? await readJavaDevices(client)
      : { deviceSelection: "read for the Java driver only (ASIO device paths are Windows-only)" };
  return { ...common, ...devices };
}

export const audioTools = [
  defineTool({
    name: "get_audio_config",
    description:
      "Read REW's audio setup in one preflight call: driver, sample rate, input/output device and input channel, and the input (mic) and output calibration. Check this before measuring — an empty inputCal.calDataAllInputs.calFilePath means NO mic calibration is loaded, which silently degrades every SPL and response reading.",
    inputSchema: {},
    handler: async (client) => readAudioConfig(client),
  }),
  defineTool({
    name: "configure_audio",
    description:
      "Set REW's audio selections — driver, sample rate, and (Java driver) input/output device, input/output selection, and input channel. Applies whichever fields are provided and returns the resulting audio config. Discover valid device/input names and sample rates from REW (/audio/java/input-devices, /audio/samplerates) or the GUI.",
    inputSchema: {
      driver: z.string().optional().describe("Audio driver, e.g. 'Java' (macOS) or 'ASIO' (Windows)"),
      sampleRateHz: z.number().positive().optional().describe("Sample rate in Hz, e.g. 48000"),
      inputDevice: z.string().optional().describe("Java input device name (see /audio/java/input-devices)"),
      input: z.string().optional().describe("Java input name for the selected device"),
      inputChannel: z.number().int().min(1).optional().describe("Input channel, 1-based"),
      outputDevice: z.string().optional().describe("Java output device name"),
      output: z.string().optional().describe("Java output name for the selected device"),
    },
    handler: async (client, args) => {
      if (Object.values(args).every((v) => v === undefined)) {
        // [LAW:no-silent-failure] a no-op configure is a caller mistake, not success.
        throw new Error("provide at least one audio setting to change (see get_audio_config)");
      }
      // [LAW:dataflow-not-control-flow] each provided value flows to its endpoint;
      // the set of writes is fixed, the data decides which ones carry a change.
      if (args.driver !== undefined) await client.post("/audio/driver", { driver: args.driver });
      if (args.sampleRateHz !== undefined) {
        await client.post("/audio/samplerate", { value: args.sampleRateHz, unit: "Hz" });
      }
      if (args.inputDevice !== undefined) {
        await client.post("/audio/java/input-device", { device: args.inputDevice });
      }
      if (args.input !== undefined) await client.post("/audio/java/input", { input: args.input });
      if (args.inputChannel !== undefined) {
        await client.post("/audio/java/input-channel", { channel: args.inputChannel });
      }
      if (args.outputDevice !== undefined) {
        await client.post("/audio/java/output-device", { device: args.outputDevice });
      }
      if (args.output !== undefined) await client.post("/audio/java/output", { output: args.output });
      return readAudioConfig(client);
    },
  }),
  defineTool({
    name: "set_input_calibration",
    description:
      "Load or clear the microphone calibration file for the current input. Pass the cal file path (forward slashes) to load it, or an empty string to clear it. Optionally set the mic sensitivity (dBFS at 94 dB SPL) from the mic's cal sheet. Verifies with get_audio_config — this is how you ensure SPL readings are accurate before measuring.",
    inputSchema: {
      calFilePath: z
        .string()
        .describe("Path to the mic cal file (forward slashes), or an empty string to clear it"),
      dBFSAt94dBSPL: z
        .number()
        .optional()
        .describe("Mic sensitivity: the dBFS level the mic reads at 94 dB SPL (from its cal sheet)"),
      fullScaleSineVrms: z.number().optional().describe("Full-scale sine Vrms for the input, if known"),
    },
    handler: async (client, args) => {
      // Round-trip the whole InputCalConfiguration so REW's read-only selection
      // fields survive; only the cal data changes. PUT is the sole write verb here.
      const config = await client.get("/audio/input-cal", inputCalSchema);
      const calData = {
        ...(config.calDataAllInputs ?? {}),
        calFilePath: args.calFilePath,
        ...(args.dBFSAt94dBSPL !== undefined ? { dBFSAt94dBSPL: args.dBFSAt94dBSPL } : {}),
        ...(args.fullScaleSineVrms !== undefined ? { fullScaleSineVrms: args.fullScaleSineVrms } : {}),
      };
      await client.put("/audio/input-cal", { ...config, calDataAllInputs: calData });
      return client.get("/audio/input-cal", unknownSchema);
    },
  }),
  defineTool({
    name: "input_levels",
    description:
      "Monitor the live input level — the 'is the mic hearing anything and is it clipping' check. action 'start' begins monitoring (starts audio capture), 'stop' ends it, 'read' returns the last measured RMS and peak per input channel. Levels populate a moment after starting, so start, then read. Levels are dBFS by default; peak near 0 dBFS means clipping.",
    inputSchema: {
      action: z
        .enum(["start", "stop", "read"])
        .describe("'start'/'stop' toggle monitoring; 'read' returns the last RMS/peak levels"),
    },
    handler: async (client, args) => {
      const commands = { start: "Start", stop: "Stop" } as const;
      // 'read' is a pure read; only start/stop post a monitoring command.
      if (args.action !== "read") {
        await client.post("/input-levels/command", { command: commands[args.action] });
      }
      return client.get("/input-levels/last-levels", unknownSchema);
    },
  }),
];
