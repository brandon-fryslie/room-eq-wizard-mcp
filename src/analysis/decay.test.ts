import { describe, expect, it } from "vitest";
import {
  decayTimeMs,
  detectRingingModes,
  summarizeDecay,
  type DecaySurface,
} from "./decay.js";

// Build a synthetic decay surface: every frequency starts at 80 dB and falls
// linearly, dropping 20 dB after `decayMsByFreq[f]` ms. One frequency is made to
// ring — it decays far slower than its neighbours.
function surface(freqsHz: number[], timesMs: number[], decayMsByFreq: number[]): DecaySurface {
  const splByTime = timesMs.map((t) =>
    freqsHz.map((_, f) => 80 - (t / decayMsByFreq[f]) * 20),
  );
  return { freqsHz, timesMs, splByTime };
}

const freqsHz = [30, 40, 50, 63, 80, 100, 125];
const timesMs = [0, 50, 100, 150, 200, 250, 300];
// All bins decay in ~80 ms except 50 Hz, which rings out to ~260 ms.
const decayByFreq = [80, 80, 260, 80, 80, 80, 80];

describe("decayTimeMs", () => {
  it("finds the time to fall the drop threshold, interpolating between slices", () => {
    const s = surface(freqsHz, timesMs, decayByFreq);
    // 50 Hz (index 2) is engineered to drop 20 dB at 260 ms.
    expect(decayTimeMs(s, 2, 20)).toBeCloseTo(260, 0);
    // 30 Hz (index 0) drops 20 dB at 80 ms.
    expect(decayTimeMs(s, 0, 20)).toBeCloseTo(80, 0);
  });

  it("returns the full time span when a frequency never falls the threshold", () => {
    const s = surface([100], [0, 100, 200], [100000]); // barely decays
    expect(decayTimeMs(s, 0, 20)).toBe(200);
  });
});

describe("detectRingingModes", () => {
  it("flags the frequency that decays slower than its neighbours, and not the rest", () => {
    const s = surface(freqsHz, timesMs, decayByFreq);
    const modes = detectRingingModes(s, 20, { minExcessMs: 50 });
    expect(modes).toHaveLength(1);
    expect(modes[0].hz).toBe(50);
    // ~260 ms decay vs ~80 ms neighbours → ~180 ms excess.
    expect(modes[0].excessMs).toBeGreaterThan(120);
    expect(modes[0].severity).toBe("moderate");
  });

  it("finds no modes when every frequency decays the same", () => {
    const s = surface(freqsHz, timesMs, freqsHz.map(() => 80));
    expect(detectRingingModes(s, 20, { minExcessMs: 50 })).toEqual([]);
  });
});

describe("summarizeDecay", () => {
  it("reduces to per-band decay and ringing modes, never raw slices", () => {
    const s = surface(freqsHz, timesMs, decayByFreq);
    const summary = summarizeDecay(s, { dropDb: 20 });
    expect(summary.rangeHz).toEqual([30, 125]);
    expect(summary.sliceCount).toBe(7);
    expect(summary.timeSpanMs).toBe(300);
    // sub-bass band (20–60 Hz) includes the 260 ms ringing bin, so its mean is raised.
    const subBass = summary.bands.find((b) => b.band === "sub-bass");
    expect(subBass?.decayMs).not.toBeNull();
    expect(summary.ringingModes.map((m) => m.hz)).toContain(50);
    // The output carries no raw surface.
    expect(summary).not.toHaveProperty("splByTime");
  });

  it("throws on an empty or single-slice surface", () => {
    expect(() => summarizeDecay({ freqsHz: [], timesMs: [], splByTime: [] })).toThrow(/empty/);
    expect(() =>
      summarizeDecay({ freqsHz: [100], timesMs: [0], splByTime: [[80]] }),
    ).toThrow(/single-slice/);
  });
});
