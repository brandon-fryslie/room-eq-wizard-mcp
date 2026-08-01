import { describe, expect, it } from "vitest";
import { z } from "zod";
import { allTools } from "./index.js";
import { spectrumSchema, toIndexedList, measurementListSchema } from "../rew/types.js";
import { encodeFloats } from "../rew/codec.js";

describe("tool registry", () => {
  it("has unique names", () => {
    const names = allTools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("every tool has a non-trivial description and a valid schema", () => {
    for (const tool of allTools) {
      expect(tool.description.length, tool.name).toBeGreaterThan(30);
      // The shape must build into a usable object schema.
      expect(() => z.object(tool.inputSchema)).not.toThrow();
    }
  });

  it("uses snake_case names compatible with MCP clients", () => {
    for (const tool of allTools) {
      expect(tool.name).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });
});

describe("wire schemas", () => {
  it("parses an index-keyed measurement list into a sorted array", () => {
    const raw = {
      "2": { uuid: "bbb", title: "Right" },
      "1": { uuid: "aaa", title: "Left" },
    };
    const list = toIndexedList(measurementListSchema.parse(raw));
    expect(list.map((m) => m.uuid)).toEqual(["aaa", "bbb"]);
    expect(list[0].index).toBe(1);
  });

  it("materialises a log-spaced frequency axis from ppo", () => {
    const spectrum = spectrumSchema.parse({
      startFreq: 20,
      ppo: 96,
      magnitude: encodeFloats([70, 71, 72]),
    });
    expect(spectrum.freqsHz[0]).toBeCloseTo(20, 6);
    expect(spectrum.freqsHz[1]).toBeCloseTo(20 * 2 ** (1 / 96), 6);
    expect(Array.from(spectrum.magDb)).toEqual([70, 71, 72]);
  });

  it("materialises a linear axis from freqStep", () => {
    const spectrum = spectrumSchema.parse({
      startFreq: 0,
      freqStep: 2.5,
      magnitude: encodeFloats([1, 2, 3]),
    });
    expect(Array.from(spectrum.freqsHz)).toEqual([0, 2.5, 5]);
  });

  it("rejects a response with neither ppo nor freqStep", () => {
    expect(() =>
      spectrumSchema.parse({ startFreq: 20, magnitude: encodeFloats([1]) }),
    ).toThrow(/ppo nor freqStep/);
  });
});
