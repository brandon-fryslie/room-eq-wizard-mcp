import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { RewClient } from "../rew/client.js";
import { stubFetch, stubFetchByPath, type FetchCall, pollingClient, stubFetchWith } from "../rew/fetch-stub.js";
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
  it("reads the session settings into one object, keyed by endpoint", async () => {
    // Keyed by path, not call order — a reorder of the reads can't mis-map values.
    stubFetchByPath({
      "/measure/measurement-mode": { body: "Single" },
      "/measure/number-of-repetitions": { body: 1 },
      "/measure/sweep/repetitions": { body: 1 },
      "/measure/timing/reference": { body: "None" },
      "/measure/playback-mode": { body: "From REW" },
      "/measure/file-playback-stimulus": { body: "" },
      "/measure/capture-noise-floor": { body: true },
      "/measure/start-delay": { body: 0 },
      "/measure/fill-silence-with-dither": { body: false },
      "/measure/invert-second-output": { body: false },
      "/measure/sequential-channels": { body: { channels: [] } },
      "/measure/start-level": { body: { value: -60, unit: "dBFS" } },
      "/measure/end-level": { body: { value: -20, unit: "dBFS" } },
      "/measure/protection-options": { body: { clippingAbort: true } },
    });
    const result = (await invoke("get_measure_config", new RewClient())) as Record<string, unknown>;
    expect(result.measurementMode).toBe("Single");
    expect(result.timingReference).toBe("None");
    expect(result.captureNoiseFloor).toBe(true);
    // Every field configure_measurement can set is read back (bar timing-offset).
    expect(result.sequentialChannels).toEqual({ channels: [] });
    expect(result.startLevel).toEqual({ value: -60, unit: "dBFS" });
    expect(result.endLevel).toEqual({ value: -20, unit: "dBFS" });
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
    // Exactly the six provided fields are written — a dropped/extra setter is caught.
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(6);
  });

  it("rejects a no-op configure before any wire call", async () => {
    const { calls } = stubFetch([{}]);
    await expect(invoke("configure_measurement", new RewClient(), {})).rejects.toThrow(
      /at least one measurement setting/,
    );
    expect(calls).toHaveLength(0);
  });

  it("rejects an empty sequentialChannels array at the schema boundary", async () => {
    stubFetch([{}]);
    await expect(
      invoke("configure_measurement", new RewClient(), { sequentialChannels: [] }),
    ).rejects.toThrow();
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
    // A zero budget makes the waiter give up after its first look, so the test
    // asserts the give-up behaviour without waiting out a real sweep's deadline.
    await expect(invoke("measure_impedance", pollingClient(0))).rejects.toThrow(/impedance jig/);
  });
});

describe("run_sweep", () => {
  // The bug this suite exists for: REW answers /measure/command with 202 Accepted in
  // ~50ms and sweeps on in the background — even with blocking mode enabled (verified
  // live, REW 5.40 beta 132). A single post-command read therefore sees the PREVIOUS
  // measurement, which run_sweep used to return as if it were the new one.
  const seeded = { "1": { uuid: "old-1", title: "yesterday" } };
  const seededPlusNew = { ...seeded, "2": { uuid: "new-1", title: "L sweep" } };

  it("returns the measurement created by this call, never the one that was already there", async () => {
    // The sweep lands only on the second poll, so a handler that reads once gets `seeded`.
    let polls = 0;
    stubFetchWith((path) => {
      if (path !== "/measurements") return {};
      polls += 1;
      return { body: polls <= 2 ? seeded : seededPlusNew };
    });
    const result = (await invoke("run_sweep", pollingClient(1000))) as {
      measurements: { uuid: string }[];
    };
    expect(result.measurements.map((m) => m.uuid)).toEqual(["new-1"]);
  });

  it("reports every measurement a Sequential/Repeated sweep created", async () => {
    let reads = 0;
    stubFetchWith((path) => {
      if (path !== "/measurements") return {};
      reads += 1;
      return { body: reads === 1 ? seeded : { ...seeded, "2": { uuid: "L" }, "3": { uuid: "R" } } };
    });
    const result = (await invoke("run_sweep", pollingClient(1000))) as {
      measurements: { uuid: string }[];
    };
    expect(result.measurements.map((m) => m.uuid)).toEqual(["L", "R"]);
  });

  it("errors instead of reporting success when the sweep produced nothing", async () => {
    stubFetchWith((path) => (path === "/measurements" ? { body: seeded } : {}));
    await expect(invoke("run_sweep", pollingClient(0))).rejects.toThrow(/No new measurement appeared/);
  });

  it("names the recovery path in the failure, not just the failure", async () => {
    stubFetchWith((path) => (path === "/measurements" ? { body: seeded } : {}));
    await expect(invoke("run_sweep", pollingClient(0))).rejects.toThrow(/get_diagnostics/);
  });

  it("configures the sweep before starting it", async () => {
    let reads = 0;
    const { calls } = stubFetchWith((path) => {
      if (path !== "/measurements") return {};
      reads += 1;
      return { body: reads === 1 ? {} : { "1": { uuid: "s1" } } };
    });
    await invoke("run_sweep", pollingClient(1000), {
      startFreqHz: 20,
      endFreqHz: 300,
      length: "512k",
      levelDbfs: -12,
    });
    expect(postBody(calls, "/measure/sweep/configuration")).toEqual({
      startFrequency: 20,
      endFrequency: 300,
      length: "512k",
    });
    expect(postBody(calls, "/measure/level")).toEqual({ value: -12, unit: "dBFS" });
    expect(postBody(calls, "/measure/command")).toEqual({ command: "SPL" });
  });

  it("shares one budget between the command and the wait, rather than stacking two", async () => {
    // The deadline is taken before the action runs. A command that itself consumes
    // the whole budget must not then buy a second full window of polling — client.ts
    // promises one commandTimeoutMs, and computing the deadline after `action()`
    // made the caller-visible wait up to twice the documented figure.
    const budgetMs = 120;
    stubFetchWith(async (path) => {
      // The sweep command itself consumes the entire budget before answering.
      if (path === "/measure/command") await new Promise((r) => setTimeout(r, budgetMs + 40));
      return path === "/measurements" ? { body: seeded } : {};
    });
    const started = Date.now();
    await expect(
      invoke(
        "run_sweep",
        new RewClient({ commandTimeoutMs: budgetMs, measurementPollIntervalMs: 0 }),
      ),
    ).rejects.toThrow(/No new measurement appeared/);
    // Two stacked windows would put this near 2x the budget; one shared window does not.
    expect(Date.now() - started).toBeLessThan(budgetMs * 2);
  });

  it("rejects an inverted frequency range before touching the wire", async () => {
    const { calls } = stubFetch([{}]);
    await expect(
      invoke("run_sweep", new RewClient(), { startFreqHz: 200, endFreqHz: 100 }),
    ).rejects.toThrow(/must be above/);
    expect(calls).toHaveLength(0);
  });
});
