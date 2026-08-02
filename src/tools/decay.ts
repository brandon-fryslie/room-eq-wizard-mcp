// Waterfall / spectrogram tools. REW's "Generate waterfall" and "Generate
// spectrogram" commands return the whole 2D surface (slices × frequencies of SPL)
// inside the blocking command result — megabytes if relayed raw. These tools parse
// that surface and hand it to the pure reducer in src/analysis/decay.ts, returning
// per-band decay times and ringing modes: findings, never raw slices.

import { z } from "zod";
import { defineTool, measurementIdInput } from "./registry.js";
import type { RewClient } from "../rew/client.js";
import { decodeFloats } from "../rew/codec.js";
import { summarizeDecay, type DecaySurface } from "../analysis/decay.js";

// REW nests the surface: the ProcessResult's `message` is a JSON string whose
// `results` maps the measurement key to { "Frequencies", "Times", "0".."N-1" },
// each a base64 big-endian float32 array. [LAW:parse-dont-validate] this is the one
// place the wire shape is decoded into a DecaySurface.
export function parseDecaySurface(raw: unknown): DecaySurface {
  const outer = raw as { message?: unknown };
  const inner: unknown =
    typeof outer?.message === "string" ? safeJsonParse(outer.message) : raw;
  const results = (inner as { results?: Record<string, Record<string, unknown>> })?.results;
  const surface = results ? Object.values(results)[0] : undefined;
  if (
    surface === undefined ||
    surface === null ||
    typeof surface["Frequencies"] !== "string" ||
    typeof surface["Times"] !== "string"
  ) {
    // [LAW:no-silent-failure] a surface without axes means the command produced no
    // waterfall (bad params, or a measurement without an IR) — say so.
    throw new Error(
      "no decay surface in the result — check the measurement has an impulse response and the parameters are valid",
    );
  }
  const freqsHz = Array.from(decodeFloats(surface["Frequencies"]));
  for (let i = 1; i < freqsHz.length; i++) {
    if (freqsHz[i] <= freqsHz[i - 1]) {
      // [LAW:parse-dont-validate] the DecaySurface contract (and localMedianDecay's
      // two-pointer window) require a strictly ascending frequency axis; stamp it.
      throw new Error(`decay surface frequencies are not strictly ascending at index ${i}`);
    }
  }
  const timesMs = Array.from(decodeFloats(surface["Times"]));
  for (let i = 1; i < timesMs.length; i++) {
    if (timesMs[i] <= timesMs[i - 1]) {
      // [LAW:parse-dont-validate] decayTimeMs interpolates between consecutive slice
      // times, so the axis must be strictly ascending; stamp it here.
      throw new Error(`decay surface times are not strictly ascending at index ${i}`);
    }
  }
  const splByTime = timesMs.map((_, t) => {
    const slice = surface[String(t)];
    if (typeof slice !== "string") throw new Error(`decay surface is missing slice ${t}`);
    const spl = Array.from(decodeFloats(slice));
    if (spl.length !== freqsHz.length) {
      // [LAW:parse-dont-validate] the returned surface is a stamp: rectangular, so
      // decayTimeMs can index splByTime[t][f] without ever reading undefined.
      throw new Error(
        `decay surface slice ${t} has ${spl.length} points but there are ${freqsHz.length} frequencies`,
      );
    }
    return spl;
  });
  return { freqsHz, timesMs, splByTime };
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function generateAndReduce(
  client: RewClient,
  measurement: string,
  command: string,
  parameters: Record<string, string>,
  dropDb: number,
): Promise<unknown> {
  const raw = await client.command(
    `/measurements/${encodeURIComponent(measurement)}/command`,
    { command, parameters },
  );
  const surface = parseDecaySurface(raw);
  return {
    kind: command === "Generate spectrogram" ? "spectrogram" : "waterfall",
    ...summarizeDecay(surface, { dropDb }),
  };
}

export const decayTools = [
  defineTool({
    name: "generate_waterfall",
    description:
      "Generate a cumulative spectral decay (waterfall) for a measurement and return a reduced analysis — per-band decay time and the ringing modes (frequencies that decay slower than their neighbours, the signature of room resonances). Never returns the raw 2D surface. Requires an impulse response (swept or imported IR).",
    inputSchema: {
      measurement: measurementIdInput,
      slices: z.number().int().min(10).max(1001).default(100).describe("Number of time slices (10–1001)"),
      timeRangeMs: z.number().positive().default(300).describe("Time span of the decay, ms"),
      ppo: z.number().int().min(1).max(48).default(12).describe("Frequency resolution, points per octave"),
      windowWidthMs: z.number().positive().default(300).describe("Analysis window width, ms"),
      riseTimeMs: z.number().positive().default(100).describe("Window rise time, ms"),
      smoothing: z.string().default("1/12").describe("Smoothing applied to each slice, e.g. '1/12'"),
      dropDb: z
        .number()
        .positive()
        .default(20)
        .describe("SPL drop the decay time is measured to (e.g. 20 = time to fall 20 dB)"),
    },
    handler: (client, args) =>
      generateAndReduce(
        client,
        args.measurement,
        "Generate waterfall",
        {
          mode: "Fourier",
          slices: String(args.slices),
          "left window type": "Hann",
          "right window type": "Tukey 0.25",
          "window width ms": String(args.windowWidthMs),
          "time range ms": String(args.timeRangeMs),
          "rise time ms": String(args.riseTimeMs),
          "use csd mode": "true",
          ppo: String(args.ppo),
          smoothing: args.smoothing,
        },
        args.dropDb,
      ),
  }),
  defineTool({
    name: "generate_spectrogram",
    description:
      "Generate a spectrogram for a measurement and return the same reduced decay analysis (per-band decay time and ringing modes) as generate_waterfall, computed over the spectrogram's time–frequency surface. Never returns the raw surface. Requires an impulse response.",
    inputSchema: {
      measurement: measurementIdInput,
      slices: z.number().int().min(10).max(1001).default(200).describe("Number of time slices (10–1001)"),
      beforeMs: z.number().min(0).default(50).describe("Time before the IR peak to include, ms"),
      afterMs: z.number().positive().default(300).describe("Time after the IR peak to include, ms"),
      ppo: z.number().int().min(1).max(48).default(12).describe("Frequency resolution, points per octave"),
      windowWidthMs: z.number().positive().default(300).describe("Analysis window width, ms"),
      dropDb: z.number().positive().default(20).describe("SPL drop the decay time is measured to"),
    },
    handler: (client, args) =>
      generateAndReduce(
        client,
        args.measurement,
        "Generate spectrogram",
        {
          mode: "Fourier",
          slices: String(args.slices),
          amplitude: "Log (dB SPL)",
          "window type": "Gaussian",
          "window width ms": String(args.windowWidthMs),
          "before ms": String(args.beforeMs),
          "after ms": String(args.afterMs),
          ppo: String(args.ppo),
        },
        args.dropDb,
      ),
  }),
];
