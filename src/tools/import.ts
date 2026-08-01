// REW's /import endpoints bring foreign data into REW: text frequency
// responses, impulse-response audio files, RTA captures, sweep recordings, and
// raw sample arrays. Native .mdat files are not imports — load_measurement_files
// covers those. Wire shapes are pinned from reference/rew-mcp-server/Docs/rew_api.md
// (the REW API help); the live suite verifies them against a running REW.
//
// [LAW:no-ambient-temporal-coupling] imports are queued and asynchronous in
// REW's default mode; every import POST goes through client.command, whose
// blocking mode makes the HTTP response itself the completion signal — so the
// measurement diff that follows each import is race-free by construction.

import { z } from "zod";
import { defineTool } from "./registry.js";
import type { RewClient } from "../rew/client.js";
import { encodeFloats } from "../rew/codec.js";
import { measurementsCreatedBy, summarize } from "./shared.js";

// [LAW:one-type-per-behavior] every import answers the same way: what REW said,
// plus exactly the measurements the import created.
async function runImport(client: RewClient, path: string, body: unknown) {
  const { result, created } = await measurementsCreatedBy(client, () => client.command(path, body));
  return {
    result: result ?? "import completed",
    importedCount: created.length,
    imported: created.map(summarize),
  };
}

const channelsInput = z
  .string()
  .optional()
  .describe(
    'Channels to read from a multichannel file, e.g. "1, 3, 5" or "2-4". Omit for all channels.',
  );

export const importTools = [
  defineTool({
    name: "import_frequency_response",
    description:
      "Import a text frequency response file (lines of frequency, SPL/impedance, optional phase) into REW as a new measurement. For native .mdat files use load_measurement_files instead.",
    inputSchema: {
      filePath: z.string().describe("Path to the text frequency response file, forward slashes"),
    },
    handler: (client, args) =>
      runImport(client, "/import/frequency-response", { path: args.filePath }),
  }),
  defineTool({
    name: "import_impulse_response",
    description:
      "Import an impulse response file (e.g. WAV) into REW; each imported channel becomes a measurement.",
    inputSchema: {
      filePath: z.string().describe("Path to the impulse response file, forward slashes"),
      channels: channelsInput,
    },
    handler: (client, args) =>
      runImport(client, "/import/impulse-response", {
        path: args.filePath,
        channels: args.channels,
      }),
  }),
  defineTool({
    name: "import_frequency_response_data",
    description:
      "Create a REW measurement from in-memory frequency response data: log-spaced magnitude values (dB SPL, or ohms for impedance) starting at startFreqHz with pointsPerOctave resolution, plus optional phase.",
    inputSchema: {
      name: z.string().describe("Name for the resulting measurement"),
      startFreqHz: z.number().positive().describe("Frequency of the first data point, Hz"),
      pointsPerOctave: z.number().positive().describe("Log spacing of the data points"),
      magnitude: z
        .array(z.number())
        .min(1)
        .describe("Magnitude values, dB SPL (or ohms when isImpedance)"),
      phaseDegrees: z
        .array(z.number())
        .optional()
        .describe("Phase values in degrees, same length as magnitude"),
      isImpedance: z
        .boolean()
        .default(false)
        .describe("Data is impedance in ohms rather than SPL"),
    },
    handler: (client, args) => {
      if (args.phaseDegrees !== undefined && args.phaseDegrees.length !== args.magnitude.length) {
        // [LAW:no-silent-failure] mismatched arrays would import as garbage, not fail
        throw new Error(
          `phaseDegrees length ${args.phaseDegrees.length} != magnitude length ${args.magnitude.length}`,
        );
      }
      return runImport(client, "/import/frequency-response-data", {
        identifier: args.name,
        isImpedance: args.isImpedance,
        startFreq: args.startFreqHz,
        ppo: args.pointsPerOctave,
        magnitude: encodeFloats(args.magnitude),
        phase: args.phaseDegrees !== undefined ? encodeFloats(args.phaseDegrees) : undefined,
      });
    },
  }),
  defineTool({
    name: "import_impulse_response_data",
    description:
      "Create a REW measurement from an in-memory impulse response: raw sample values at a given sample rate.",
    inputSchema: {
      name: z.string().describe("Name for the resulting measurement"),
      sampleRate: z.number().positive().describe("Sample rate of the data, Hz"),
      samples: z.array(z.number()).min(1).describe("Impulse response sample values"),
      startTimeSeconds: z
        .number()
        .default(0)
        .describe("Time of the first sample, seconds (negative places samples before t=0)"),
      splOffsetDb: z
        .number()
        .default(0)
        .describe("dB value added to the data to obtain SPL"),
      applyCal: z
        .boolean()
        .default(false)
        .describe("Apply the current measurement input's calibration files"),
    },
    handler: (client, args) =>
      runImport(client, "/import/impulse-response-data", {
        identifier: args.name,
        startTime: args.startTimeSeconds,
        sampleRate: args.sampleRate,
        splOffset: args.splOffsetDb,
        applyCal: args.applyCal,
        data: encodeFloats(args.samples),
      }),
  }),
  defineTool({
    name: "import_rta_file",
    description:
      "Import an audio file through REW's RTA, producing an RTA measurement of its spectrum.",
    inputSchema: {
      filePath: z.string().describe("Path to the audio file, forward slashes"),
      channel: z.number().int().min(1).default(1).describe("Channel to read from the file, 1-based"),
    },
    handler: (client, args) =>
      runImport(client, "/import/rta-file", { path: args.filePath, channel: args.channel }),
  }),
  defineTool({
    name: "import_sweep_recordings",
    description:
      "Import a recorded sweep as a measurement: set the sweep stimulus file, then import the recorded response file. Each imported channel becomes a measurement, as if REW had measured it live.",
    inputSchema: {
      stimulusPath: z.string().describe("Path to the sweep stimulus file, forward slashes"),
      responsePath: z.string().describe("Path to the recorded sweep response file, forward slashes"),
      channels: channelsInput,
    },
    handler: async (client, args) => {
      // Setting the stimulus is a quick settings write that answers with a
      // summary of the stimulus parameters; the response POST runs the import.
      const stimulus = await client.post("/import/sweep-recordings/stimulus", {
        path: args.stimulusPath,
      });
      const imported = await runImport(client, "/import/sweep-recordings/response", {
        path: args.responsePath,
        channels: args.channels,
      });
      return { stimulus, ...imported };
    },
  }),
];
