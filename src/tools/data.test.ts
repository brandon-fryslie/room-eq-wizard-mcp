import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { RewClient } from "../rew/client.js";
import { stubFetch, type FetchCall } from "../rew/fetch-stub.js";
import { encodeFloats } from "../rew/codec.js";
import { allTools } from "./index.js";

async function invoke(name: string, client: RewClient, args: Record<string, unknown> = {}) {
  const tool = allTools.find((t) => t.name === name);
  if (tool === undefined) throw new Error(`no tool named ${name}`);
  return tool.handler(client, z.object(tool.inputSchema).parse(args));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const bodyAt = (calls: FetchCall[], method: string, path: string) =>
  calls.find((c) => c.method === method && new URL(c.url).pathname === path)?.body;

describe("get_impulse_response", () => {
  it("returns IR metadata and peak, forwarding windowed/normalised, not the samples", async () => {
    const { calls } = stubFetch([
      { body: { startTime: 0, sampleInterval: 1 / 48000, sampleRate: 48000, timingReference: "Acoustic", data: encodeFloats([0, 0.5, -0.8, 0.2]) } },
    ]);
    const result = (await invoke("get_impulse_response", new RewClient(), {
      measurement: "m1",
      windowed: true,
    })) as { numSamples: number; peakSample: number; sampleRate: number };
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/measurements/m1/impulse-response");
    expect(url.searchParams.get("windowed")).toBe("true");
    expect(url.searchParams.get("normalised")).toBe("true");
    expect(result.numSamples).toBe(4);
    expect(result.peakSample).toBeCloseTo(0.8, 5);
    expect(result.sampleRate).toBe(48000);
    expect(result).not.toHaveProperty("data");
  });

  it("reports REW's no-IR message instead of a parse error", async () => {
    stubFetch([{ body: { message: "Measurement does not have an impulse response" } }]);
    await expect(invoke("get_impulse_response", new RewClient(), { measurement: "m1" })).rejects.toThrow(
      /no impulse response/,
    );
  });
});

describe("get_group_delay", () => {
  it("returns a decimated group-delay curve in seconds", async () => {
    stubFetch([{ body: { unit: "seconds", startFreq: 20, ppo: 6, magnitude: encodeFloats([0.001, 0.002, 0.0015]) } }]);
    const result = (await invoke("get_group_delay", new RewClient(), { measurement: "m1" })) as {
      unit: string;
      points: unknown[];
    };
    expect(result.unit).toBe("seconds");
    expect(result.points).toHaveLength(3);
  });
});

describe("ir_windows", () => {
  it("reads the windows when no settings are given", async () => {
    const { calls } = stubFetch([{ body: { leftWindowType: "Tukey 0.25", addFDW: false } }]);
    const result = await invoke("ir_windows", new RewClient(), { measurement: "m1" });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("GET");
    expect(result).toEqual({ leftWindowType: "Tukey 0.25", addFDW: false });
  });

  it("merges provided fields over current and PUTs them", async () => {
    const { calls } = stubFetch([
      { body: { leftWindowType: "Tukey 0.25", addFDW: false, fdwWidthCycles: 5 } }, // current
      {}, // PUT
      { body: { leftWindowType: "Tukey 0.25", addFDW: true, fdwWidthCycles: 15 } }, // re-read
    ]);
    await invoke("ir_windows", new RewClient(), {
      measurement: "m1",
      settings: { addFDW: true, fdwWidthCycles: 15 },
    });
    expect(bodyAt(calls, "PUT", "/measurements/m1/ir-windows")).toEqual({
      leftWindowType: "Tukey 0.25",
      addFDW: true,
      fdwWidthCycles: 15,
    });
  });
});
