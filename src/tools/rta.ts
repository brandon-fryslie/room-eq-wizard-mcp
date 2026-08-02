// REW's RTA (Real Time Analyzer) is the no-sweep capture path: it accumulates a
// live spectrum from whatever is playing (music, pink noise) and answers the same
// FrequencyResponse wire shape a swept measurement does. Command names (Start,
// Stop, Reset averaging, Save current/peak/both) are verified live against
// /rta/commands by the integration suite; the full authoritative list is whatever
// REW answers there, surfaced by get_rta_state and reachable via run_rta_command.

import { z } from "zod";
import { defineTool } from "./registry.js";
import type { RewClient } from "../rew/client.js";
import { spectrumSchema, unknownSchema, type Spectrum } from "../rew/types.js";
import { decimateLog, summarizeSpectrum } from "../analysis/spectrum.js";
import { measurementsCreatedBy, summarize } from "./shared.js";

// KNOWN LANDMINE: RTA spectrum captures are linear-spaced from 0 Hz, so the wire
// axis carries a 0 Hz bin. The pure analysis layer is log-based — decimateLog takes
// Math.log(freqsHz[0]) and localBaseline divides by freqsHz[i], both of which
// blow up at 0 Hz. [LAW:parse-dont-validate] Excise the non-positive bins here, at
// the one boundary where RTA data is parsed, so the Spectrum that flows downstream
// structurally cannot carry a 0 Hz bin — no scattered guards, nothing to re-check.
function positiveFrequenciesOnly(spectrum: Spectrum): Spectrum {
  // The axis is ascending (ppo and freqStep both climb), so the non-positive bins
  // are a contiguous prefix — find its length and drop it in one slice.
  // [LAW:dataflow-not-control-flow] the slice runs unconditionally; a fully-positive
  // log capture yields first=0 and subarray(0) is the identity, no special case.
  let first = 0;
  while (first < spectrum.freqsHz.length && spectrum.freqsHz[first] <= 0) first++;
  return {
    freqsHz: spectrum.freqsHz.subarray(first),
    magDb: spectrum.magDb.subarray(first),
    phaseDeg: spectrum.phaseDeg?.subarray(first),
    unit: spectrum.unit,
    smoothing: spectrum.smoothing,
  };
}

/**
 * The RTA capture wire shape with the 0 Hz bin already removed. Holding this type
 * is the stamp: code receiving an rtaSpectrum never has to wonder whether a 0 Hz
 * bin is lurking. [LAW:parse-dont-validate]
 */
export const rtaSpectrumSchema = spectrumSchema.transform(positiveFrequenciesOnly);

// When the RTA has never run (or was just reset) the capture endpoints answer
// { "message": "There is no data" } instead of a FrequencyResponse. Parse the two
// wire shapes as the discriminated union they are, so the no-data case becomes a
// clear, actionable error rather than a cryptic "startFreq required" Zod failure.
// [LAW:parse-dont-validate] the boundary decides which shape arrived, once.
//
// Order matters: the spectrum schema is tried first because noCaptureDataSchema is
// a loose object that would also match a real spectrum carrying a stray `message`
// field. A genuine capture always has startFreq+magnitude and matches the spectrum
// schema; the no-data payload lacks startFreq and falls through to the sentinel.
const noCaptureDataSchema = z.looseObject({ message: z.string() });
const rtaCaptureSchema = z.union([rtaSpectrumSchema, noCaptureDataSchema]);

async function fetchCapture(
  client: RewClient,
  peak: boolean,
  unit: string | undefined,
): Promise<Spectrum> {
  const endpoint = peak ? "/rta/captured-peak-data" : "/rta/captured-data";
  const captured = await client.get(endpoint, rtaCaptureSchema, { unit });
  // [LAW:no-silent-failure] both no-data shapes — REW's sentinel message, and a
  // capture with no usable bins above 0 Hz — are real states to report here, so the
  // returned Spectrum is a stamp: non-empty and all-positive. The caller never guards.
  const reason = "message" in captured ? `REW: "${captured.message}"` : "no bins above 0 Hz";
  if ("message" in captured || captured.freqsHz.length === 0) {
    throw new Error(
      `RTA has no captured data (${reason}) — start the RTA (control_rta start) ` +
        `and let it accumulate before capturing`,
    );
  }
  return captured;
}

// REW command names for the RTA control endpoint, verified live against
// /rta/commands. [LAW:one-source-of-truth] the action→command mapping lives once;
// the enum below is derived from these keys, and the live suite iterates the values
// to confirm REW still advertises them — so these constants are the only place the
// strings appear. Exported for that reason (cf. alignmentStateEndpoints).
export const RTA_CONTROL_COMMANDS = {
  start: "Start",
  stop: "Stop",
  // Zeroes the running average — the sample sum the captured/level endpoints
  // report resets from here, so accumulation restarts fresh.
  reset: "Reset averaging",
} as const;

// The three "save the current capture as a measurement" commands, verified live.
export const RTA_SAVE_COMMANDS = {
  current: "Save current",
  peak: "Save peak",
  both: "Save both",
} as const;

export const rtaTools = [
  defineTool({
    name: "get_rta_state",
    description:
      "Read the RTA's current state in one call: whether it is enabled and running, its configuration (mode, smoothing, fftLength, window, averaging, maximumOverlap — REW's own field names, echo them back through configure_rta to change them), and the list of commands this REW version accepts (feed these to run_rta_command).",
    inputSchema: {},
    handler: async (client) => ({
      status: await client.get("/rta/status", unknownSchema),
      configuration: await client.get("/rta/configuration", unknownSchema),
      availableCommands: await client.get("/rta/commands", unknownSchema),
    }),
  }),
  defineTool({
    name: "get_rta_levels",
    description:
      "Read the RTA's current input level(s) — one RTALevel entry, or two when stereo inputs are being captured. Use to confirm signal is present and at a sane level before capturing. Default unit is SPL.",
    inputSchema: {
      unit: z.string().optional().describe("Level unit, e.g. 'dBFS' (default: SPL). See /rta/levels/units in REW."),
    },
    handler: async (client, args) => client.get("/rta/levels", unknownSchema, { unit: args.unit }),
  }),
  defineTool({
    name: "get_rta_capture",
    description:
      "Read the RTA's current captured spectrum as a log-spaced, decimated curve plus summary statistics — the live-capture analogue of get_frequency_response. Reads the rms average by default, or the peak-hold trace with peak=true. The 0 Hz bin that RTA spectrum captures carry is excluded automatically.",
    inputSchema: {
      peak: z
        .boolean()
        .default(false)
        .describe("Read the peak-hold trace (/rta/captured-peak-data) instead of the rms average"),
      unit: z.string().optional().describe("Magnitude unit, e.g. 'dBFS' (default: SPL)"),
      maxPoints: z
        .number()
        .int()
        .min(10)
        .max(500)
        .default(120)
        .describe("Maximum points returned (log-spaced bin averages)"),
    },
    handler: async (client, args) => {
      // fetchCapture returns a non-empty, all-positive Spectrum or throws — no guard here.
      const spectrum = await fetchCapture(client, args.peak, args.unit);
      const summary = summarizeSpectrum(spectrum.freqsHz, spectrum.magDb);
      return {
        capture: args.peak ? "peak" : "rms",
        unit: spectrum.unit,
        smoothing: spectrum.smoothing,
        rangeHz: summary.rangeHz,
        meanDb: summary.meanDb,
        stdDevDb: summary.stdDevDb,
        points: decimateLog(spectrum.freqsHz, spectrum.magDb, args.maxPoints),
      };
    },
  }),
  defineTool({
    name: "configure_rta",
    description:
      "Change RTA settings by posting any subset of REW's own configuration fields (read them first with get_rta_state). Common knobs: mode ('Spectrum', '1/1 octave', '1/12 octave'…), smoothing, fftLength ('64k'), window ('Hann'), averaging ('None', 'Forever', a number), maximumOverlap ('50%'). Returns the resulting configuration. Note values are REW's own literals — many are strings, not numbers.",
    inputSchema: {
      settings: z
        .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
        .describe(
          'RTA config fields to set, e.g. { "mode": "1/12 octave", "averaging": "Forever" }. Field names and current values come from get_rta_state.',
        ),
    },
    handler: async (client, args) => {
      if (Object.keys(args.settings).length === 0) {
        // [LAW:no-silent-failure] a no-op configure is a caller mistake, not a success.
        throw new Error("provide at least one RTA setting to change — see get_rta_state for field names");
      }
      await client.post("/rta/configuration", args.settings);
      return client.get("/rta/configuration", unknownSchema);
    },
  }),
  defineTool({
    name: "control_rta",
    description:
      "Start, stop, or reset REW's RTA. 'start' begins accumulating the spectrum from the current input; 'stop' halts it; 'reset' zeroes the running average so accumulation restarts fresh. Returns the resulting RTA status.",
    inputSchema: {
      action: z
        .enum(["start", "stop", "reset"])
        .describe("start begins capture, stop halts it, reset zeroes the average and restarts accumulation"),
    },
    handler: async (client, args) => {
      // Plain POST, never the blocking command path: 'start' runs the RTA
      // continuously, so a blocking call would never return. [LAW:no-ambient-temporal-coupling]
      await client.post("/rta/command", { command: RTA_CONTROL_COMMANDS[args.action] });
      return client.get("/rta/status", unknownSchema);
    },
  }),
  defineTool({
    name: "save_rta_capture",
    description:
      "Save the RTA's current spectrum into a new measurement, so it can be analysed, compared, or EQ'd like any swept measurement. This is the core no-sweep workflow: play music or pink noise, let the RTA settle, then save. Choose the rms 'current' trace (default), the 'peak'-hold trace, or 'both'. Returns the measurement(s) created.",
    inputSchema: {
      which: z
        .enum(["current", "peak", "both"])
        .default("current")
        .describe("Which trace to save: 'current' (rms average), 'peak' (peak-hold), or 'both'"),
    },
    handler: async (client, args) => {
      // Blocking command so the new measurement exists before the diff reads it.
      const { created } = await measurementsCreatedBy(client, () =>
        client.command("/rta/command", { command: RTA_SAVE_COMMANDS[args.which] }),
      );
      if (created.length === 0) {
        // [LAW:no-silent-failure] the whole point is a new measurement; if none
        // appeared the capture did not take (RTA not started, or no data), and a
        // success-shaped empty result would hide that.
        throw new Error(
          "RTA save produced no measurement — start the RTA and confirm it has data (get_rta_capture) before saving",
        );
      }
      return { savedCount: created.length, saved: created.map(summarize) };
    },
  }),
  defineTool({
    name: "run_rta_command",
    description:
      "Run a raw RTA command (discover names with get_rta_state's availableCommands). Escape hatch for commands without a dedicated tool, e.g. 'Save graph image'. Parameters are passed as REW's positional array, e.g. { command: 'Save graph image', parameters: ['/path/rta.png'] }.",
    inputSchema: {
      command: z.string().describe("RTA command name, e.g. 'Start', 'Save graph image'"),
      parameters: z
        .array(z.union([z.string(), z.number(), z.boolean()]))
        .optional()
        .describe("Positional command parameters, e.g. ['/path/rta.png'] for 'Save graph image'"),
    },
    handler: async (client, args) => {
      const result = await client.post("/rta/command", {
        command: args.command,
        parameters: args.parameters ?? [],
      });
      return result ?? `Command '${args.command}' completed`;
    },
  }),
];
