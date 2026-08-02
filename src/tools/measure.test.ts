import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { RewClient } from "../rew/client.js";
import { stubFetch, type FetchCall } from "../rew/fetch-stub.js";
import { allTools } from "./index.js";

// [LAW:behavior-not-structure] assert the wire contract. The /measure write actions
// are Pro-gated on a real REW (401 without a Pro license), so these mocks are the
// authoritative check that the bodies are shaped correctly.
async function invoke(name: string, client: RewClient, args: Record<string, unknown> = {}) {
  const tool = allTools.find((t) => t.name === name);
  if (tool === undefined) throw new Error(`no tool named ${name}`);
  return tool.handler(client, z.object(tool.inputSchema).parse(args));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const postBody = (calls: FetchCall[], path: string) =>
  calls.find((c) => c.method === "POST" && new URL(c.url).pathname === path)?.body;

describe("get_measure_config", () => {
  it("reads the session settings into one object", async () => {
    stubFetch([
      { body: "Single" }, // measurement-mode
      { body: 1 }, // number-of-repetitions
      { body: 1 }, // sweep/repetitions
      { body: "None" }, // timing/reference
      { body: "From REW" }, // playback-mode
      { body: true }, // capture-noise-floor
      { body: 0 }, // start-delay
      { body: false }, // fill-silence-with-dither
      { body: false }, // invert-second-output
      { body: { clippingAbort: true } }, // protection-options
    ]);
    const result = (await invoke("get_measure_config", new RewClient())) as Record<string, unknown>;
    expect(result.measurementMode).toBe("Single");
    expect(result.captureNoiseFloor).toBe(true);
    expect(result.protectionOptions).toEqual({ clippingAbort: true });
  });
});

describe("configure_measurement", () => {
  it("posts bare scalars to their endpoints and {value,unit} for ramp levels", async () => {
    const { calls } = stubFetch([{ body: {} }]);
    await invoke("configure_measurement", new RewClient(), {
      measurementMode: "Ramped",
      numberOfRepetitions: 5,
      captureNoiseFloor: false,
      sequentialChannels: ["L", "R"],
      rampStartLevelDbfs: -20,
      rampEndLevelDbfs: -6,
    });
    expect(postBody(calls, "/measure/measurement-mode")).toBe("Ramped");
    expect(postBody(calls, "/measure/number-of-repetitions")).toBe(5);
    expect(postBody(calls, "/measure/capture-noise-floor")).toBe(false);
    expect(postBody(calls, "/measure/sequential-channels")).toEqual(["L", "R"]);
    expect(postBody(calls, "/measure/start-level")).toEqual({ value: -20, unit: "dBFS" });
    expect(postBody(calls, "/measure/end-level")).toEqual({ value: -6, unit: "dBFS" });
  });

  it("rejects a no-op configure before any wire call", async () => {
    const { calls } = stubFetch([{}]);
    await expect(invoke("configure_measurement", new RewClient(), {})).rejects.toThrow(
      /at least one measurement setting/,
    );
    expect(calls).toHaveLength(0);
  });
});

describe("set_measurement_protection", () => {
  it("merges provided options over the current ones and returns the result", async () => {
    const { calls } = stubFetch([
      { body: { clippingAbort: true, splLimitAbort: false, dBSPLLimit: 100, warnForLowSNR: true } },
      {}, // POST
      { body: { clippingAbort: true, splLimitAbort: true, dBSPLLimit: 90, warnForLowSNR: true } }, // re-read
    ]);
    const result = await invoke("set_measurement_protection", new RewClient(), {
      splLimitAbort: true,
      dBSPLLimit: 90,
    });
    // Existing clippingAbort/warnForLowSNR preserved; only provided fields changed.
    expect(postBody(calls, "/measure/protection-options")).toEqual({
      clippingAbort: true,
      splLimitAbort: true,
      dBSPLLimit: 90,
      warnForLowSNR: true,
    });
    expect(result).toMatchObject({ dBSPLLimit: 90 });
  });

  it("rejects a no-op before touching the wire", async () => {
    const { calls } = stubFetch([{}]);
    await expect(invoke("set_measurement_protection", new RewClient(), {})).rejects.toThrow(
      /at least one protection option/,
    );
    expect(calls).toHaveLength(0);
  });
});

describe("measure_impedance", () => {
  it("runs the Impedance command and reports the created measurement", async () => {
    const { calls } = stubFetch([
      { body: {} }, // measurements before
      {}, // blocking
      {}, // command
      { body: { "1": { uuid: "imp-1", title: "Impedance" } } }, // after
    ]);
    const result = await invoke("measure_impedance", new RewClient());
    expect(postBody(calls, "/measure/command")).toEqual({ command: "Impedance" });
    expect(result).toEqual({ step: "measure", measurement: expect.objectContaining({ uuid: "imp-1" }) });
  });

  it("runs a calibration step without expecting a measurement", async () => {
    const { calls } = stubFetch([{}, { body: "cal done" }]); // blocking, command
    const result = await invoke("measure_impedance", new RewClient(), { step: "open-cal" });
    expect(postBody(calls, "/measure/command")).toEqual({ command: "Impedance open cal" });
    expect(result).toEqual({ step: "open-cal", result: "cal done" });
  });

  it("fails loudly when an impedance measurement produces nothing", async () => {
    stubFetch([
      { body: { "1": { uuid: "m1" } } }, // before
      {}, // blocking
      {}, // command
      { body: { "1": { uuid: "m1" } } }, // after unchanged
    ]);
    await expect(invoke("measure_impedance", new RewClient())).rejects.toThrow(/no measurement/);
  });
});
