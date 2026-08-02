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

const wire = (calls: FetchCall[]) =>
  calls.map((c) => [c.method, new URL(c.url).pathname, c.body] as const);
const bodyAt = (calls: FetchCall[], method: string, path: string) =>
  calls.find((c) => c.method === method && new URL(c.url).pathname === path)?.body;

describe("house_curve", () => {
  it("sets the log-interpolation flag before the file path", async () => {
    const { calls } = stubFetch([{}, {}, { body: "/hc.txt" }, { body: true }]);
    const result = await invoke("house_curve", new RewClient(), {
      action: "set",
      path: "/hc.txt",
      logInterpolation: true,
    });
    const posts = wire(calls).filter(([m]) => m === "POST");
    expect(posts).toEqual([
      ["POST", "/eq/house-curve-log-interpolation", true],
      ["POST", "/eq/house-curve", "/hc.txt"],
    ]);
    expect(result).toEqual({ path: "/hc.txt", logInterpolation: true });
  });

  it("rejects 'set' with no path", async () => {
    const { calls } = stubFetch([{}]);
    await expect(
      invoke("house_curve", new RewClient(), { action: "set" }),
    ).rejects.toThrow(/requires a 'path'/);
    expect(calls).toHaveLength(0);
  });

  it("clears the house curve with DELETE", async () => {
    const { calls } = stubFetch([{}, { body: "" }, { body: true }]);
    await invoke("house_curve", new RewClient(), { action: "clear" });
    expect(calls.some((c) => c.method === "DELETE" && new URL(c.url).pathname === "/eq/house-curve")).toBe(true);
  });
});

describe("get_target_response", () => {
  it("summarises the target as a decimated curve", async () => {
    stubFetch([{ body: { startFreq: 20, ppo: 6, magnitude: encodeFloats([75, 74, 73, 72]) } }]);
    const result = (await invoke("get_target_response", new RewClient(), { measurement: "m1" })) as {
      points: unknown[];
    };
    expect(result.points.length).toBe(4);
  });
});

describe("eq_match_target_settings", () => {
  it("reads settings when none are provided", async () => {
    const { calls } = stubFetch([{ body: { individualMaxBoostdB: 9 } }]);
    const result = await invoke("eq_match_target_settings", new RewClient());
    expect(wire(calls)).toEqual([["GET", "/eq/match-target-settings", undefined]]);
    expect(result).toEqual({ individualMaxBoostdB: 9 });
  });

  it("merges provided fields over the current settings and re-reads", async () => {
    const { calls } = stubFetch([
      { body: { individualMaxBoostdB: 9, overallMaxBoostdB: 0 } }, // current
      {}, // POST
      { body: { individualMaxBoostdB: 6, overallMaxBoostdB: 0 } }, // re-read
    ]);
    await invoke("eq_match_target_settings", new RewClient(), {
      settings: { individualMaxBoostdB: 6 },
    });
    expect(bodyAt(calls, "POST", "/eq/match-target-settings")).toEqual({
      individualMaxBoostdB: 6,
      overallMaxBoostdB: 0,
    });
  });
});

describe("run_eq_command", () => {
  it("runs the command and reports created measurements and the filter bank", async () => {
    const { calls } = stubFetch([
      { body: {} }, // measurements before
      {}, // blocking
      {}, // eq/command
      { body: { "1": { uuid: "gen-1", title: "Filters" } } }, // measurements after
      { body: [{ index: 1, type: "PK", enabled: true }] }, // filters
    ]);
    const result = (await invoke("run_eq_command", new RewClient(), {
      measurement: "m1",
      command: "Generate filters measurement",
    })) as { created: unknown[]; filters: unknown[] };
    expect(bodyAt(calls, "POST", "/measurements/m1/eq/command")).toEqual({
      command: "Generate filters measurement",
    });
    expect(result.created).toEqual([expect.objectContaining({ uuid: "gen-1" })]);
    expect(result.filters).toHaveLength(1);
  });
});

describe("get_filters_impulse_response", () => {
  it("requests the IR at the given rate/length and returns metadata, not samples", async () => {
    const { calls } = stubFetch([
      { body: { sampleRate: 48000, sampleInterval: 1 / 48000, startTime: 0, data: encodeFloats([0, 0.5, -0.9, 0.1]) } },
    ]);
    const result = (await invoke("get_filters_impulse_response", new RewClient(), {
      measurement: "m1",
      sampleRate: 48000,
      length: 4,
    })) as { numSamples: number; peakSample: number };
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/measurements/m1/filters-impulse-response");
    expect(url.searchParams.get("samplerate")).toBe("48000");
    expect(url.searchParams.get("length")).toBe("4");
    expect(result.numSamples).toBe(4);
    expect(result.peakSample).toBeCloseTo(0.9, 5);
    expect(result).not.toHaveProperty("data");
  });

  it("reports REW's no-effective-filters message instead of a parse error", async () => {
    stubFetch([{ body: { message: "Dirac 48000 does not have any filters that have an effect" } }]);
    await expect(
      invoke("get_filters_impulse_response", new RewClient(), { measurement: "m1" }),
    ).rejects.toThrow(/no filter impulse response/);
  });
});
