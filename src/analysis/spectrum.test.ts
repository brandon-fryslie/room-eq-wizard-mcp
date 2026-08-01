import { describe, expect, it } from "vitest";
import {
  decimateLog,
  detectExtrema,
  diffSpectra,
  localBaseline,
  summarizeSpectrum,
} from "./spectrum.js";

/** Log-spaced axis from 20 Hz to 20 kHz at the given points per octave. */
function logAxis(ppo: number, startHz = 20, endHz = 20000): Float64Array {
  const octaves = Math.log2(endHz / startHz);
  const n = Math.floor(octaves * ppo) + 1;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = startHz * 2 ** (i / ppo);
  return out;
}

/** Flat response with a Gaussian (in log-frequency) bump of `heightDb` at `centerHz`. */
function flatWithBump(
  freqs: Float64Array,
  centerHz: number,
  heightDb: number,
  widthOctaves = 0.15,
): Float64Array {
  const out = new Float64Array(freqs.length);
  for (let i = 0; i < freqs.length; i++) {
    const octaveDistance = Math.log2(freqs[i] / centerHz);
    out[i] = 75 + heightDb * Math.exp(-((octaveDistance / widthOctaves) ** 2));
  }
  return out;
}

describe("localBaseline", () => {
  it("returns the input for a constant signal", () => {
    const freqs = logAxis(24);
    const mags = new Float64Array(freqs.length).fill(80);
    const avg = localBaseline(freqs, mags, 1);
    for (const value of avg) expect(value).toBeCloseTo(80, 10);
  });
});

describe("detectExtrema", () => {
  const freqs = logAxis(96);

  it("finds a single peak at the right frequency with the right severity", () => {
    // The median baseline ignores the narrow bump, so the reported deviation
    // tracks the raw 15 dB height — past the 10 dB "severe" threshold.
    const mags = flatWithBump(freqs, 100, 15);
    const extrema = detectExtrema(freqs, mags);
    expect(extrema.length).toBe(1);
    const peak = extrema[0];
    expect(peak.kind).toBe("peak");
    expect(peak.hz).toBeGreaterThan(90);
    expect(peak.hz).toBeLessThan(110);
    expect(peak.severity).toBe("severe");
    expect(peak.q).not.toBeNull();
  });

  it("finds a null and reports negative deviation", () => {
    const mags = flatWithBump(freqs, 63, -9);
    const extrema = detectExtrema(freqs, mags);
    expect(extrema.length).toBe(1);
    expect(extrema[0].kind).toBe("null");
    expect(extrema[0].deviationDb).toBeLessThan(-6);
    expect(extrema[0].severity).toBe("moderate");
  });

  it("reports nothing on a flat response", () => {
    const mags = new Float64Array(freqs.length).fill(75);
    expect(detectExtrema(freqs, mags)).toEqual([]);
  });

  it("separates two distinct peaks", () => {
    const a = flatWithBump(freqs, 50, 8);
    const b = flatWithBump(freqs, 400, 8);
    const mags = new Float64Array(freqs.length);
    for (let i = 0; i < mags.length; i++) mags[i] = a[i] + b[i] - 75;
    const extrema = detectExtrema(freqs, mags);
    expect(extrema.length).toBe(2);
    expect(extrema[0].hz).toBeLessThan(60);
    expect(extrema[1].hz).toBeGreaterThan(300);
  });

  it("ignores deviations below the threshold", () => {
    const mags = flatWithBump(freqs, 100, 2);
    expect(detectExtrema(freqs, mags, { minDeviationDb: 3 })).toEqual([]);
  });
});

describe("summarizeSpectrum", () => {
  it("computes band means and overall statistics", () => {
    const freqs = logAxis(48);
    const mags = new Float64Array(freqs.length).fill(70);
    const summary = summarizeSpectrum(freqs, mags);
    expect(summary.meanDb).toBe(70);
    expect(summary.stdDevDb).toBe(0);
    for (const band of summary.bands) expect(band.meanDb).toBe(70);
  });

  it("marks uncovered bands as null", () => {
    const freqs = Float64Array.from([1000, 1100, 1200]);
    const mags = Float64Array.from([70, 70, 70]);
    const summary = summarizeSpectrum(freqs, mags);
    const subBass = summary.bands.find((b) => b.band === "sub-bass");
    expect(subBass?.meanDb).toBeNull();
  });

  it("throws on an empty spectrum", () => {
    expect(() => summarizeSpectrum([], [])).toThrow(/empty/);
  });
});

describe("decimateLog", () => {
  it("passes small inputs through", () => {
    const points = decimateLog([100, 200], [70, 72], 50);
    expect(points).toEqual([
      { hz: 100, db: 70 },
      { hz: 200, db: 72 },
    ]);
  });

  it("reduces large inputs to at most maxPoints while preserving level", () => {
    const freqs = logAxis(96);
    const mags = new Float64Array(freqs.length).fill(75);
    const points = decimateLog(freqs, mags, 100);
    expect(points.length).toBeLessThanOrEqual(100);
    expect(points.length).toBeGreaterThan(50);
    for (const point of points) expect(point.db).toBe(75);
    // Frequency coverage spans the original range.
    expect(points[0].hz).toBeLessThan(25);
    expect(points[points.length - 1].hz).toBeGreaterThan(15000);
  });
});

describe("diffSpectra", () => {
  it("subtracts on the overlap with interpolation", () => {
    const freqs = logAxis(48, 20, 2000);
    const a = new Float64Array(freqs.length).fill(80);
    const b = new Float64Array(freqs.length).fill(74);
    const diff = diffSpectra({ freqsHz: freqs, magDb: a }, { freqsHz: freqs, magDb: b });
    expect(diff.freqsHz.length).toBe(freqs.length);
    for (const value of diff.magDb) expect(value).toBeCloseTo(6, 6);
  });

  it("throws when ranges do not overlap", () => {
    expect(() =>
      diffSpectra(
        { freqsHz: [20, 30, 40], magDb: [70, 70, 70] },
        { freqsHz: [1000, 2000], magDb: [70, 70] },
      ),
    ).toThrow(/overlap/);
  });
});
