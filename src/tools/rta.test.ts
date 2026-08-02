import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { RewClient } from "../rew/client.js";
import { stubFetch, type FetchCall } from "../rew/fetch-stub.js";
import { encodeFloats } from "../rew/codec.js";
import { allTools } from "./index.js";
import { rtaSpectrumSchema } from "./rta.js";

// [LAW:behavior-not-structure] assert the wire contract — endpoints and bodies —
// and the observable output, never the handlers' internals. Args cross the tool's
// own Zod shape first, exactly as the MCP layer does.
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

// The landmine this ticket exists to defuse: RTA spectrum captures are linear
// from 0 Hz, and the log-based analysis layer cannot survive a 0 Hz bin.
describe("rtaSpectrumSchema — 0 Hz exclusion", () => {
  it("drops the leading 0 Hz bin from a synthetic linear-axis capture", () => {
    const spectrum = rtaSpectrumSchema.parse({
      startFreq: 0,
      freqStep: 10,
      magnitude: encodeFloats([1, 2, 3, 4]),
      phase: encodeFloats([0, 10, 20, 30]),
    });
    // Base axis would be [0, 10, 20, 30]; the 0 Hz bin (and its magnitude/phase)
    // must be gone so nothing downstream takes log(0) or divides by 0.
    expect(Array.from(spectrum.freqsHz)).toEqual([10, 20, 30]);
    expect(Array.from(spectrum.magDb)).toEqual([2, 3, 4]);
    expect(Array.from(spectrum.phaseDeg ?? [])).toEqual([10, 20, 30]);
    expect(spectrum.freqsHz.every((hz) => hz > 0)).toBe(true);
  });

  it("leaves a log-spaced (ppo) capture untouched — it is already all-positive", () => {
    const spectrum = rtaSpectrumSchema.parse({
      startFreq: 20,
      ppo: 48,
      magnitude: encodeFloats([70, 71, 72]),
    });
    expect(spectrum.freqsHz[0]).toBeCloseTo(20, 6);
    expect(Array.from(spectrum.magDb)).toEqual([70, 71, 72]);
  });
});

describe("get_rta_state", () => {
  it("reads status, configuration, and the available command list", async () => {
    const commands = ["Start", "Stop", "Reset averaging", "Save current", "Save peak", "Save both"];
    const { calls } = stubFetch([
      { body: { enabled: true, running: true } },
      { body: { mode: "Spectrum", fftLength: "64k", window: "Hann" } },
      { body: commands },
    ]);
    const result = await invoke("get_rta_state", new RewClient());
    expect(wire(calls).map(([m, p]) => [m, p])).toEqual([
      ["GET", "/rta/status"],
      ["GET", "/rta/configuration"],
      ["GET", "/rta/commands"],
    ]);
    expect(result).toEqual({
      status: { enabled: true, running: true },
      configuration: { mode: "Spectrum", fftLength: "64k", window: "Hann" },
      availableCommands: commands,
    });
  });
});

describe("get_rta_levels", () => {
  it("reads /rta/levels and forwards the requested unit", async () => {
    const { calls } = stubFetch([{ body: [{ spl: 82.5, sampleCount: 48000 }] }]);
    const result = await invoke("get_rta_levels", new RewClient(), { unit: "dBFS" });
    expect(new URL(calls[0].url).pathname).toBe("/rta/levels");
    expect(new URL(calls[0].url).searchParams.get("unit")).toBe("dBFS");
    expect(result).toEqual([{ spl: 82.5, sampleCount: 48000 }]);
  });
});

describe("get_rta_capture", () => {
  it("summarises the rms capture with the 0 Hz bin excluded", async () => {
    stubFetch([
      { body: { startFreq: 0, freqStep: 10, magnitude: encodeFloats([1, 2, 3, 4, 5, 6]) } },
    ]);
    const result = (await invoke("get_rta_capture", new RewClient())) as {
      capture: string;
      rangeHz: [number, number];
      points: Array<{ hz: number; db: number }>;
    };
    expect(result.capture).toBe("rms");
    // 0 Hz dropped: axis is 10..50 Hz, first magnitude (the 0 Hz bin) gone.
    expect(result.rangeHz).toEqual([10, 50]);
    expect(result.points[0]).toEqual({ hz: 10, db: 2 });
    expect(result.points).toHaveLength(5);
  });

  it("forwards the requested unit as a query parameter", async () => {
    const { calls } = stubFetch([
      { body: { startFreq: 0, freqStep: 10, magnitude: encodeFloats([1, 2, 3]) } },
    ]);
    await invoke("get_rta_capture", new RewClient(), { unit: "dBFS" });
    expect(new URL(calls[0].url).pathname).toBe("/rta/captured-data");
    expect(new URL(calls[0].url).searchParams.get("unit")).toBe("dBFS");
  });

  it("reads the peak-hold trace from captured-peak-data when peak=true", async () => {
    const { calls } = stubFetch([
      { body: { startFreq: 0, freqStep: 10, magnitude: encodeFloats([1, 2, 3, 4]) } },
    ]);
    const result = (await invoke("get_rta_capture", new RewClient(), { peak: true })) as {
      capture: string;
    };
    expect(new URL(calls[0].url).pathname).toBe("/rta/captured-peak-data");
    expect(result.capture).toBe("peak");
  });

  it("reports REW's no-data message instead of a cryptic parse error", async () => {
    stubFetch([{ body: { message: "There is no data" } }]);
    await expect(invoke("get_rta_capture", new RewClient())).rejects.toThrow(/There is no data/);
  });

  it("parses a real spectrum that carries a stray message field as a spectrum, not no-data", async () => {
    // Regression: the no-data sentinel is a loose object, so union order must put
    // the spectrum schema first — otherwise a capture with an extra 'message' field
    // would be misclassified as no-data and throw.
    stubFetch([
      { body: { startFreq: 0, freqStep: 10, magnitude: encodeFloats([1, 2, 3]), message: "ok" } },
    ]);
    const result = (await invoke("get_rta_capture", new RewClient())) as { capture: string };
    expect(result.capture).toBe("rms");
  });

  it("fails loudly when the capture holds nothing but the 0 Hz bin", async () => {
    stubFetch([{ body: { startFreq: 0, freqStep: 10, magnitude: encodeFloats([1]) } }]);
    await expect(invoke("get_rta_capture", new RewClient())).rejects.toThrow(/no captured data/);
  });
});

describe("configure_rta", () => {
  it("rejects empty settings before touching the wire", async () => {
    const { calls } = stubFetch([{}]);
    await expect(invoke("configure_rta", new RewClient(), { settings: {} })).rejects.toThrow(
      /at least one RTA setting/,
    );
    expect(calls).toHaveLength(0);
  });

  it("posts the partial settings and returns the re-read configuration", async () => {
    const config = { mode: "1/12 octave", fftLength: "64k", window: "Hann" };
    const { calls } = stubFetch([{}, { body: config }]);
    const result = await invoke("configure_rta", new RewClient(), {
      settings: { mode: "1/12 octave" },
    });
    expect(wire(calls)).toEqual([
      ["POST", "/rta/configuration", { mode: "1/12 octave" }],
      ["GET", "/rta/configuration", undefined],
    ]);
    expect(result).toEqual(config);
  });
});

describe("control_rta", () => {
  it.each([
    ["start", "Start"],
    ["stop", "Stop"],
    ["reset", "Reset averaging"],
  ])("maps action %s to REW command %s and returns status", async (action, command) => {
    const { calls } = stubFetch([{}, { body: { enabled: true, running: action !== "stop" } }]);
    const result = await invoke("control_rta", new RewClient(), { action });
    expect(wire(calls)).toEqual([
      ["POST", "/rta/command", { command }],
      ["GET", "/rta/status", undefined],
    ]);
    expect(result).toEqual({ enabled: true, running: action !== "stop" });
  });
});

describe("save_rta_capture", () => {
  it("saves the current trace into a measurement and reports the one that appeared", async () => {
    const { calls } = stubFetch([
      { body: {} }, // measurements before: none
      {}, // /application/blocking enable
      {}, // /rta/command Save current
      { body: { "1": { uuid: "rta-1", title: "RTA capture" } } }, // measurements after
    ]);
    const result = await invoke("save_rta_capture", new RewClient());
    expect(wire(calls).filter(([m]) => m === "POST")).toEqual([
      ["POST", "/application/blocking", true],
      ["POST", "/rta/command", { command: "Save current" }],
    ]);
    expect(result).toEqual({
      savedCount: 1,
      saved: [expect.objectContaining({ uuid: "rta-1", index: 1, title: "RTA capture" })],
    });
  });

  it("maps which=both to REW's 'Save both' and reports every measurement created", async () => {
    const { calls } = stubFetch([
      { body: {} }, // before
      {}, // blocking
      {}, // command
      { body: { "1": { uuid: "rms-1" }, "2": { uuid: "peak-1" } } }, // after: two appeared
    ]);
    const result = (await invoke("save_rta_capture", new RewClient(), { which: "both" })) as {
      savedCount: number;
    };
    expect(calls.find((c) => new URL(c.url).pathname === "/rta/command")?.body).toEqual({
      command: "Save both",
    });
    expect(result.savedCount).toBe(2);
  });

  it("fails loudly when the capture produced no measurement", async () => {
    stubFetch([
      { body: { "1": { uuid: "m1" } } }, // before
      {}, // blocking
      {}, // command
      { body: { "1": { uuid: "m1" } } }, // after — unchanged
    ]);
    await expect(invoke("save_rta_capture", new RewClient())).rejects.toThrow(/no measurement/);
  });
});

describe("run_rta_command", () => {
  it("posts a raw command with its positional parameter array", async () => {
    const { calls } = stubFetch([{ body: "Saved" }]);
    const result = await invoke("run_rta_command", new RewClient(), {
      command: "Save graph image",
      parameters: ["/tmp/rta.png"],
    });
    expect(wire(calls)).toEqual([
      ["POST", "/rta/command", { command: "Save graph image", parameters: ["/tmp/rta.png"] }],
    ]);
    expect(result).toBe("Saved");
  });

  it("defaults parameters to an empty array", async () => {
    const { calls } = stubFetch([{}]);
    await invoke("run_rta_command", new RewClient(), { command: "Start" });
    expect(calls[0].body).toEqual({ command: "Start", parameters: [] });
  });
});
