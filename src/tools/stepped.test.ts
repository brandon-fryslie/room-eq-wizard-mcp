import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { RewClient } from "../rew/client.js";
import { stubFetch, stubFetchByPath, type FetchCall } from "../rew/fetch-stub.js";
import { allTools } from "./index.js";

async function invoke(name: string, client: RewClient, args: Record<string, unknown> = {}) {
  const tool = allTools.find((t) => t.name === name);
  if (tool === undefined) throw new Error(`no tool named ${name}`);
  return tool.handler(client, z.object(tool.inputSchema).parse(args));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const bodyAt = (calls: FetchCall[], path: string) =>
  calls.find((c) => c.method === "POST" && new URL(c.url).pathname === path)?.body;

const configPaths = () => ({
  "/stepped-measurement/types": { body: ["THD vs frequency", "THD vs level"] },
  "/stepped-measurement/type": { body: "THD vs frequency" },
  "/stepped-measurement/frequency-span": { body: { startFreq: 20, endFreq: 20000, ppo: 3 } },
  "/stepped-measurement/level-span": { body: { startLevel: -80, endLevel: 0, step: 10 } },
  "/stepped-measurement/fft-configuration": { body: { fftLength: "64k", averages: 2 } },
  "/stepped-measurement/options": { body: { stopAtDistortionLimit: true, distortionLimitPercent: 1 } },
});

describe("get_stepped_config", () => {
  it("reads the type, spans, fft config, and options into one object", async () => {
    stubFetchByPath(configPaths());
    const result = (await invoke("get_stepped_config", new RewClient())) as Record<string, unknown>;
    expect(result.type).toBe("THD vs frequency");
    expect(result.frequencySpan).toEqual({ startFreq: 20, endFreq: 20000, ppo: 3 });
    expect(result.options).toMatchObject({ stopAtDistortionLimit: true });
  });
});

describe("configure_stepped", () => {
  it("posts the type and merges a frequency-span field", async () => {
    const { calls } = stubFetchByPath(configPaths());
    await invoke("configure_stepped", new RewClient(), {
      type: "THD vs level",
      frequencySpan: { ppo: 6 },
    });
    expect(bodyAt(calls, "/stepped-measurement/type")).toBe("THD vs level");
    // Merged over current: ppo changed, start/end preserved.
    expect(bodyAt(calls, "/stepped-measurement/frequency-span")).toEqual({
      startFreq: 20,
      endFreq: 20000,
      ppo: 6,
    });
  });

  it("rejects a no-op configure", async () => {
    const { calls } = stubFetch([{}]);
    await expect(invoke("configure_stepped", new RewClient(), {})).rejects.toThrow(
      /at least one stepped-measurement setting/,
    );
    expect(calls).toHaveLength(0);
  });
});

describe("start_stepped_measurement", () => {
  it("posts Start with the settling time and stimulus, then returns progress", async () => {
    const { calls } = stubFetch([{}, { body: { point: 0, points: 31 } }]);
    const result = (await invoke("start_stepped_measurement", new RewClient(), {
      settlingTimeMs: 200,
      frequencyHz: 1000,
    })) as { started: boolean };
    expect(bodyAt(calls, "/stepped-measurement/command")).toEqual({
      command: "Start",
      settlingTimems: 200,
      frequencyHz: 1000,
    });
    expect(result.started).toBe(true);
  });

  it("maps levelDbfs to REW's leveldBFS wire key", async () => {
    const { calls } = stubFetch([{}, { body: {} }]);
    await invoke("start_stepped_measurement", new RewClient(), {
      settlingTimeMs: 100,
      levelDbfs: -12,
    });
    expect(bodyAt(calls, "/stepped-measurement/command")).toEqual({
      command: "Start",
      settlingTimems: 100,
      leveldBFS: -12,
    });
  });

  it("passes an IMD stimulus and includes only the provided stimulus key", async () => {
    const { calls } = stubFetch([{}, { body: {} }]);
    await invoke("start_stepped_measurement", new RewClient(), {
      settlingTimeMs: 100,
      imdStimulus: "SMPTE",
    });
    const body = bodyAt(calls, "/stepped-measurement/command") as Record<string, unknown>;
    expect(body).toEqual({ command: "Start", settlingTimems: 100, imdStimulus: "SMPTE" });
    expect(body).not.toHaveProperty("frequencyHz");
    expect(body).not.toHaveProperty("leveldBFS");
  });

  it("rejects Start with no stimulus before any wire call", async () => {
    const { calls } = stubFetch([{}]);
    await expect(
      invoke("start_stepped_measurement", new RewClient(), { settlingTimeMs: 100 }),
    ).rejects.toThrow(/provide a stimulus/);
    expect(calls).toHaveLength(0);
  });
});

describe("control_stepped_measurement", () => {
  it.each([
    ["stop", "Stop"],
    ["cancel", "Cancel"],
    ["pause", "Pause"],
    ["resume", "Resume"],
    ["back", "Back"],
  ])("maps %s to the %s command", async (action, command) => {
    const { calls } = stubFetch([{}, { body: { point: 1, points: 31 } }]);
    await invoke("control_stepped_measurement", new RewClient(), { action });
    expect(bodyAt(calls, "/stepped-measurement/command")).toEqual({ command });
  });
});

describe("get_stepped_progress", () => {
  it("reads the progress endpoint", async () => {
    const { calls } = stubFetch([{ body: { point: 5, points: 31, message: "26 remaining" } }]);
    const result = await invoke("get_stepped_progress", new RewClient());
    expect(new URL(calls[0].url).pathname).toBe("/stepped-measurement/progress");
    expect(result).toEqual({ point: 5, points: 31, message: "26 remaining" });
  });
});
