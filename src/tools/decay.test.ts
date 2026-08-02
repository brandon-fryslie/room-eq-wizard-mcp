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

// A REW waterfall result: the ProcessResult's `message` is a JSON string whose
// results map the measurement key to Frequencies/Times/slice base64 arrays.
// Here 50 Hz decays slower (drops 20 dB at t=200) than 40/63 Hz (at t=100).
function waterfallResult() {
  return {
    message: JSON.stringify({
      processName: "Generate waterfall ID 1",
      message: "Completed",
      results: {
        "0": {
          Frequencies: encodeFloats([40, 50, 63]),
          Times: encodeFloats([0, 100, 200]),
          "0": encodeFloats([80, 80, 80]),
          "1": encodeFloats([60, 78, 60]),
          "2": encodeFloats([40, 60, 40]),
        },
      },
    }),
  };
}

describe("generate_waterfall", () => {
  it("runs the command and returns reduced decay findings, not raw slices", async () => {
    const { calls } = stubFetch([{}, { body: waterfallResult() }]); // blocking, command
    const result = (await invoke("generate_waterfall", new RewClient(), {
      measurement: "m1",
      slices: 10,
    })) as { kind: string; rangeHz: [number, number]; ringingModes: Array<{ hz: number }> };

    const cmd = calls.find((c) => new URL(c.url).pathname === "/measurements/m1/command");
    expect((cmd?.body as { command: string }).command).toBe("Generate waterfall");
    expect((cmd?.body as { parameters: { slices: string } }).parameters.slices).toBe("10");
    expect(result.kind).toBe("waterfall");
    expect(result.rangeHz).toEqual([40, 63]);
    expect(result.ringingModes.map((m) => m.hz)).toContain(50);
    expect(result).not.toHaveProperty("splByTime");
  });

  it("fails loudly when the result carries no decay surface", async () => {
    stubFetch([{}, { body: { message: "Measurement does not have an impulse response" } }]);
    await expect(invoke("generate_waterfall", new RewClient(), { measurement: "m1" })).rejects.toThrow(
      /no decay surface/,
    );
  });

  it("rejects a ragged surface where a slice's length differs from the frequency count", async () => {
    const ragged = {
      message: JSON.stringify({
        results: {
          "0": {
            Frequencies: encodeFloats([40, 50, 63]),
            Times: encodeFloats([0, 100]),
            "0": encodeFloats([80, 80, 80]),
            "1": encodeFloats([60, 60]), // one value short
          },
        },
      }),
    };
    stubFetch([{}, { body: ragged }]);
    await expect(invoke("generate_waterfall", new RewClient(), { measurement: "m1" })).rejects.toThrow(
      /has 2 points but there are 3 frequencies/,
    );
  });

  it("fails loudly when a measurement maps to a null surface", async () => {
    stubFetch([{}, { body: { message: JSON.stringify({ results: { "0": null } }) } }]);
    await expect(invoke("generate_waterfall", new RewClient(), { measurement: "m1" })).rejects.toThrow(
      /no decay surface/,
    );
  });

  it("rejects a non-ascending frequency axis", async () => {
    const outOfOrder = {
      message: JSON.stringify({
        results: {
          "0": {
            Frequencies: encodeFloats([40, 63, 50]), // not ascending
            Times: encodeFloats([0, 100]),
            "0": encodeFloats([80, 80, 80]),
            "1": encodeFloats([60, 60, 60]),
          },
        },
      }),
    };
    stubFetch([{}, { body: outOfOrder }]);
    await expect(invoke("generate_waterfall", new RewClient(), { measurement: "m1" })).rejects.toThrow(
      /not strictly ascending/,
    );
  });

  it("rejects a non-ascending time axis", async () => {
    const badTimes = {
      message: JSON.stringify({
        results: {
          "0": {
            Frequencies: encodeFloats([40, 50, 63]),
            Times: encodeFloats([0, 100, 50]), // not ascending
            "0": encodeFloats([80, 80, 80]),
            "1": encodeFloats([70, 70, 70]),
            "2": encodeFloats([60, 60, 60]),
          },
        },
      }),
    };
    stubFetch([{}, { body: badTimes }]);
    await expect(invoke("generate_waterfall", new RewClient(), { measurement: "m1" })).rejects.toThrow(
      /times are not strictly ascending/,
    );
  });
});

describe("generate_spectrogram", () => {
  it("uses the Generate spectrogram command and reduces the same way", async () => {
    const { calls } = stubFetch([{}, { body: waterfallResult() }]);
    const result = (await invoke("generate_spectrogram", new RewClient(), { measurement: "m1" })) as {
      kind: string;
      rangeHz: [number, number];
      sliceCount: number;
      bands: unknown[];
      ringingModes: Array<{ hz: number }>;
    };
    const cmd = calls.find((c: FetchCall) => new URL(c.url).pathname === "/measurements/m1/command");
    expect((cmd?.body as { command: string }).command).toBe("Generate spectrogram");
    expect(result.kind).toBe("spectrogram");
    // Full reduction is produced, same as the waterfall path.
    expect(result.rangeHz).toEqual([40, 63]);
    expect(result.sliceCount).toBe(3);
    expect(result.bands.length).toBeGreaterThan(0);
    expect(result.ringingModes.map((m) => m.hz)).toContain(50);
  });
});
