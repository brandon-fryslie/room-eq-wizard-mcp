import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { RewClient } from "../rew/client.js";
import { stubFetch, type FetchCall } from "../rew/fetch-stub.js";
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
  calls.find((c) => new URL(c.url).pathname === path)?.body;

describe("arithmetic", () => {
  it("passes the inversion/merge parameters that make 1/A a usable correction", async () => {
    const { calls } = stubFetch([{}, { body: "ok" }, { body: {} }]); // blocking, process, measurements
    await invoke("arithmetic", new RewClient(), {
      measurementA: "a",
      measurementB: "b",
      operation: "1 / A",
      maxGainDb: 12,
      targetLevelDb: 0,
      autoTarget: true,
      excludeNotches: true,
      mergeFrequencyHz: 200,
      mergeBlend: true,
    });
    expect(bodyAt(calls, "/measurements/process-measurements")).toEqual({
      processName: "Arithmetic",
      measurementUUIDs: ["a", "b"],
      parameters: {
        function: "1 / A",
        maxGain: "12",
        mergeFrequency: "200",
        mergeBlend: true,
        targetLevel: "0",
        autoTarget: true,
        excludeNotches: true,
      },
    });
  });
});

describe("align_ir", () => {
  it("runs the chosen IR-align process, and creates no measurement (2 calls)", async () => {
    const { calls } = stubFetch([{}, { body: "ok" }]); // blocking + process only
    const result = await invoke("align_ir", new RewClient(), {
      measurements: ["a", "b"],
      method: "Cross corr align",
    });
    expect(bodyAt(calls, "/measurements/process-measurements")).toMatchObject({
      processName: "Cross corr align",
      measurementUUIDs: ["a", "b"],
    });
    // No measurement-list fetch — it modifies in place, so exactly two calls.
    expect(calls).toHaveLength(2);
    expect(result).toMatchObject({ createdMeasurement: false });
  });
});

describe("generate_phase_version", () => {
  it("runs the phase command with a flat parameter object and reports the new measurement", async () => {
    const { calls } = stubFetch([
      { body: {} }, // measurements before
      {}, // blocking
      {}, // command
      { body: { "1": { uuid: "min-1", title: "Min phase" } } }, // after
    ]);
    const result = (await invoke("generate_phase_version", new RewClient(), {
      measurement: "m1",
      kind: "minimum",
      appendLfTail: true,
      lfTailStartHz: 27,
      lfTailSlopeDbPerOctave: 12,
    })) as { command: string; measurement: unknown };
    expect(bodyAt(calls, "/measurements/m1/command")).toEqual({
      command: "Minimum phase version",
      parameters: {
        "include cal": true,
        "append lf tail": true,
        "lf tail start": 27,
        "lf tail slope": 12,
        "append hf tail": false,
        "frequency warping": false,
        "replicate data": false,
      },
    });
    expect(result.command).toBe("Minimum phase version");
    expect(result.measurement).toEqual(expect.objectContaining({ uuid: "min-1" }));
  });

  it("uses the Excess phase command for kind=excess", async () => {
    const { calls } = stubFetch([{ body: {} }, {}, {}, { body: { "1": { uuid: "exc-1" } } }]);
    await invoke("generate_phase_version", new RewClient(), { measurement: "m1", kind: "excess" });
    expect((bodyAt(calls, "/measurements/m1/command") as { command: string }).command).toBe(
      "Excess phase version",
    );
  });

  it("fails loudly when the command produces no measurement", async () => {
    stubFetch([
      { body: { "1": { uuid: "m1" } } }, // before
      {}, // blocking
      {}, // command
      { body: { "1": { uuid: "m1" } } }, // after — unchanged
    ]);
    await expect(
      invoke("generate_phase_version", new RewClient(), { measurement: "m1" }),
    ).rejects.toThrow(/produced no measurement/);
  });
});
