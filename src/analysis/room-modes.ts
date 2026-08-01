// [LAW:effects-at-boundaries] Pure modal acoustics: room geometry in, mode
// predictions out. Correlation against measured extrema is a pure join.

import type { Extremum } from "./spectrum.js";

/** Speed of sound in air at ~20 °C, m/s. */
const SPEED_OF_SOUND = 343;

export interface RoomDimensions {
  lengthM: number;
  widthM: number;
  heightM: number;
}

export interface RoomMode {
  /** Count of non-zero orders names the type: 1 axial, 2 tangential, 3 oblique. */
  type: "axial" | "tangential" | "oblique";
  /** Half-wavelength counts along [length, width, height]. */
  order: [number, number, number];
  hz: number;
}

export interface ModeMatch {
  mode: RoomMode;
  measured: Extremum;
  /** Predicted minus measured frequency, Hz. */
  errorHz: number;
}

const MODE_TYPES = [undefined, "axial", "tangential", "oblique"] as const;

/**
 * Rectangular-room standing wave frequencies below maxHz:
 *   f = (c/2) · sqrt((nl/L)² + (nw/W)² + (nh/H)²)
 */
export function roomModes(dims: RoomDimensions, maxHz = 300): RoomMode[] {
  const { lengthM, widthM, heightM } = dims;
  if (lengthM <= 0 || widthM <= 0 || heightM <= 0) {
    throw new Error(`room dimensions must be positive (got ${lengthM}×${widthM}×${heightM} m)`);
  }
  const half = SPEED_OF_SOUND / 2;
  const maxOrder = (dimM: number): number => Math.floor((maxHz * dimM) / half);
  const modes: RoomMode[] = [];
  for (let nl = 0; nl <= maxOrder(lengthM); nl++) {
    for (let nw = 0; nw <= maxOrder(widthM); nw++) {
      for (let nh = 0; nh <= maxOrder(heightM); nh++) {
        const nonZero = (nl > 0 ? 1 : 0) + (nw > 0 ? 1 : 0) + (nh > 0 ? 1 : 0);
        if (nonZero === 0) continue;
        const hz =
          half * Math.hypot(nl / lengthM, nw / widthM, nh / heightM);
        if (hz > maxHz) continue;
        modes.push({
          type: MODE_TYPES[nonZero] as RoomMode["type"],
          order: [nl, nw, nh],
          hz: Math.round(hz * 10) / 10,
        });
      }
    }
  }
  return modes.sort((a, b) => a.hz - b.hz);
}

/**
 * Pair predicted modes with measured peaks/nulls. A match tolerates the larger
 * of 2 Hz and 5% of the mode frequency — modal frequencies shift with furnishing
 * and boundary compliance, so exact agreement is not the expectation.
 */
export function correlateModes(modes: RoomMode[], measured: Extremum[]): ModeMatch[] {
  const matches: ModeMatch[] = [];
  for (const extremum of measured) {
    let best: ModeMatch | null = null;
    for (const mode of modes) {
      const errorHz = mode.hz - extremum.hz;
      const tolerance = Math.max(2, mode.hz * 0.05);
      if (Math.abs(errorHz) > tolerance) continue;
      if (best === null || Math.abs(errorHz) < Math.abs(best.errorHz)) {
        best = { mode, measured: extremum, errorHz: Math.round(errorHz * 10) / 10 };
      }
    }
    if (best !== null) matches.push(best);
  }
  return matches;
}

/**
 * Schroeder frequency 2000·sqrt(RT60/V): above it the room behaves statistically
 * and modal treatment stops being the story.
 */
export function schroederFrequency(rt60Seconds: number, volumeM3: number): number {
  if (rt60Seconds <= 0 || volumeM3 <= 0) {
    throw new Error("RT60 and volume must be positive");
  }
  return Math.round(2000 * Math.sqrt(rt60Seconds / volumeM3) * 10) / 10;
}
