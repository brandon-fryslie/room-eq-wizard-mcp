import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { RewClient } from "../rew/client.js";
import { decodeFloats } from "../rew/codec.js";
import { stubFetch } from "../rew/fetch-stub.js";
import { allTools } from "./index.js";

// [LAW:behavior-not-structure] these tests assert the wire contract — which
// endpoints receive which bodies — never the handlers' internals. Args pass
// through the tool's own Zod shape first, exactly as the MCP layer does.
async function invoke(name: string, client: RewClient, args: Record<string, unknown> = {}) {
  const tool = allTools.find((t) => t.name === name);
  if (tool === undefined) throw new Error(`no tool named ${name}`);
  return tool.handler(client, z.object(tool.inputSchema).parse(args));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// Every import follows the same choreography: list measurements, enable
// blocking, POST the import, list measurements again to diff.
const importChoreography = (importResponse: { body?: unknown } = {}) => [
  { body: { "1": { uuid: "aaa", title: "Existing" } } }, // measurements before
  {}, // blocking
  importResponse, // the import POST
  {
    body: {
      "1": { uuid: "aaa", title: "Existing" },
      "2": { uuid: "new", title: "Imported" },
    },
  }, // measurements after
];

function importPost(calls: Array<{ url: string; method: string; body: unknown }>) {
  const post = calls.find((c) => c.method === "POST" && c.url.includes("/import/"));
  if (post === undefined) throw new Error("no POST to an /import endpoint");
  return { path: new URL(post.url).pathname, body: post.body as Record<string, unknown> };
}

describe("import_frequency_response", () => {
  it("posts the file path and reports the measurement that appeared", async () => {
    const { calls } = stubFetch(importChoreography());
    const result = await invoke("import_frequency_response", new RewClient(), {
      filePath: "/tmp/fr.txt",
    });
    expect(importPost(calls)).toEqual({
      path: "/import/frequency-response",
      body: { path: "/tmp/fr.txt" },
    });
    expect(result).toMatchObject({
      importedCount: 1,
      imported: [{ uuid: "new", index: 2, title: "Imported" }],
    });
  });
});

describe("import_impulse_response", () => {
  it("includes channels when given", async () => {
    const { calls } = stubFetch(importChoreography());
    await invoke("import_impulse_response", new RewClient(), {
      filePath: "/tmp/ir.wav",
      channels: "1-3, 5",
    });
    expect(importPost(calls)).toEqual({
      path: "/import/impulse-response",
      body: { path: "/tmp/ir.wav", channels: "1-3, 5" },
    });
  });

  it("omits channels from the wire when not given, so REW loads all", async () => {
    const { calls } = stubFetch(importChoreography());
    await invoke("import_impulse_response", new RewClient(), { filePath: "/tmp/ir.wav" });
    expect(importPost(calls).body).toEqual({ path: "/tmp/ir.wav" });
  });
});

describe("import_frequency_response_data", () => {
  // Values exactly representable in float32, so the base64 round-trip is exact.
  const magnitude = [75.5, 80.25, 82];

  it("sends the documented FrequencyResponseData shape with base64 magnitude", async () => {
    const { calls } = stubFetch(importChoreography());
    await invoke("import_frequency_response_data", new RewClient(), {
      name: "my import",
      startFreqHz: 20,
      pointsPerOctave: 48,
      magnitude,
    });
    const { path, body } = importPost(calls);
    expect(path).toBe("/import/frequency-response-data");
    expect(body).toMatchObject({
      identifier: "my import",
      isImpedance: false,
      startFreq: 20,
      ppo: 48,
    });
    expect(body).not.toHaveProperty("phase");
    expect([...decodeFloats(body.magnitude as string)]).toEqual(magnitude);
  });

  it("encodes phase when provided", async () => {
    const { calls } = stubFetch(importChoreography());
    await invoke("import_frequency_response_data", new RewClient(), {
      name: "with phase",
      startFreqHz: 20,
      pointsPerOctave: 96,
      magnitude,
      phaseDegrees: [0, -45.5, -90],
    });
    const { body } = importPost(calls);
    expect([...decodeFloats(body.phase as string)]).toEqual([0, -45.5, -90]);
  });

  it("rejects mismatched magnitude/phase lengths before touching the wire", async () => {
    const { calls } = stubFetch([{}]);
    await expect(
      invoke("import_frequency_response_data", new RewClient(), {
        name: "bad",
        startFreqHz: 20,
        pointsPerOctave: 48,
        magnitude,
        phaseDegrees: [0],
      }),
    ).rejects.toThrow(/phaseDegrees length 1 != magnitude length 3/);
    expect(calls).toHaveLength(0);
  });
});

describe("import_impulse_response_data", () => {
  it("sends the documented ImpulseResponseData shape with defaults applied", async () => {
    const { calls } = stubFetch(importChoreography());
    const samples = [0, 1, -0.5, 0.25];
    await invoke("import_impulse_response_data", new RewClient(), {
      name: "ir import",
      sampleRate: 48000,
      samples,
    });
    const { path, body } = importPost(calls);
    expect(path).toBe("/import/impulse-response-data");
    expect(body).toMatchObject({
      identifier: "ir import",
      startTime: 0,
      sampleRate: 48000,
      splOffset: 0,
      applyCal: false,
    });
    expect([...decodeFloats(body.data as string)]).toEqual(samples);
  });
});

describe("import_rta_file", () => {
  it("posts path and channel, defaulting to channel 1", async () => {
    const { calls } = stubFetch(importChoreography());
    await invoke("import_rta_file", new RewClient(), { filePath: "/tmp/pink.wav" });
    expect(importPost(calls)).toEqual({
      path: "/import/rta-file",
      body: { path: "/tmp/pink.wav", channel: 1 },
    });
  });
});

describe("import_sweep_recordings", () => {
  it("sets the stimulus, then imports the response, and reports both", async () => {
    const { calls } = stubFetch([
      { body: "stimulus 20-20000Hz 256k" }, // stimulus summary
      { body: { "1": { uuid: "aaa" } } }, // measurements before
      {}, // blocking
      {}, // response import
      { body: { "1": { uuid: "aaa" }, "2": { uuid: "new", title: "Sweep" } } },
    ]);
    const result = await invoke("import_sweep_recordings", new RewClient(), {
      stimulusPath: "/tmp/stimulus.wav",
      responsePath: "/tmp/response.wav",
      channels: "2",
    });
    const posts = calls
      .filter((c) => c.method === "POST" && c.url.includes("/import/"))
      .map((c) => [new URL(c.url).pathname, c.body]);
    expect(posts).toEqual([
      ["/import/sweep-recordings/stimulus", { path: "/tmp/stimulus.wav" }],
      ["/import/sweep-recordings/response", { path: "/tmp/response.wav", channels: "2" }],
    ]);
    expect(result).toMatchObject({
      stimulus: "stimulus 20-20000Hz 256k",
      importedCount: 1,
      imported: [{ uuid: "new" }],
    });
  });
});
