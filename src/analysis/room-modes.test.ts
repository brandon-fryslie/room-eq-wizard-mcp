import { describe, expect, it } from "vitest";
import { correlateModes, roomModes, schroederFrequency } from "./room-modes.js";
import type { Extremum } from "./spectrum.js";

describe("roomModes", () => {
  // 6 × 4 × 2.5 m room: first axial modes at 343/(2·6)=28.6, 343/(2·4)=42.9, 343/(2·2.5)=68.6 Hz.
  const dims = { lengthM: 6, widthM: 4, heightM: 2.5 };

  it("predicts first-order axial modes at c/2L", () => {
    const axial = roomModes(dims, 300).filter((m) => m.type === "axial");
    const firstOrders = axial.filter((m) => m.order.reduce((s, o) => s + o, 0) === 1);
    expect(firstOrders.map((m) => m.hz)).toEqual([28.6, 42.9, 68.6]);
  });

  it("classifies mode types by non-zero order count", () => {
    const modes = roomModes(dims, 100);
    const tangential = modes.find((m) => m.order[0] === 1 && m.order[1] === 1 && m.order[2] === 0);
    expect(tangential?.type).toBe("tangential");
    // f(1,1,0) = (343/2)·sqrt((1/6)² + (1/4)²) ≈ 51.5 Hz
    expect(tangential?.hz).toBeCloseTo(51.5, 1);
    const oblique = modes.find((m) => m.order.every((o) => o === 1));
    expect(oblique?.type).toBe("oblique");
  });

  it("respects the frequency ceiling and sorts ascending", () => {
    const modes = roomModes(dims, 150);
    expect(modes.every((m) => m.hz <= 150)).toBe(true);
    for (let i = 1; i < modes.length; i++) expect(modes[i].hz).toBeGreaterThanOrEqual(modes[i - 1].hz);
  });

  it("rejects non-positive dimensions", () => {
    expect(() => roomModes({ lengthM: 0, widthM: 4, heightM: 2.5 })).toThrow(/positive/);
  });
});

describe("correlateModes", () => {
  const modes = roomModes({ lengthM: 6, widthM: 4, heightM: 2.5 }, 300);
  const peakAt = (hz: number): Extremum => ({
    kind: "peak",
    hz,
    db: 82,
    deviationDb: 8,
    q: 6,
    severity: "moderate",
  });

  it("matches a measured peak to the nearest predicted mode", () => {
    const matches = correlateModes(modes, [peakAt(43.5)]);
    expect(matches.length).toBe(1);
    expect(matches[0].mode.hz).toBeCloseTo(42.9, 1);
  });

  it("leaves unrelated features unmatched", () => {
    // 33 Hz sits between the 28.6 and 42.9 modes, outside 5% tolerance of both.
    expect(correlateModes(modes, [peakAt(33)])).toEqual([]);
  });
});

describe("schroederFrequency", () => {
  it("computes 2000·sqrt(T/V)", () => {
    // T=0.36 s, V=60 m³ → 2000·sqrt(0.006) ≈ 154.9 Hz
    expect(schroederFrequency(0.36, 60)).toBeCloseTo(154.9, 1);
  });

  it("rejects non-positive inputs", () => {
    expect(() => schroederFrequency(0, 60)).toThrow(/positive/);
  });
});
