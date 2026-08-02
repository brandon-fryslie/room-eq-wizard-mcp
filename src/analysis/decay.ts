// [LAW:effects-at-boundaries] Pure decay-surface reduction: a 2D waterfall in,
// findings out. No I/O, no REW, no clock — every function is unit-testable with
// literal arrays.
//
// A waterfall is slices × frequencies of SPL — the megabytes-into-context problem
// one dimension worse than a curve. This layer is the decay-data analogue of
// src/analysis/spectrum.ts: it never returns raw slices, only reduced findings —
// per-band decay time, and modal ringing (frequencies that decay slower than their
// neighbours, the signature of a room mode).

export interface DecaySurface {
  /** Frequency axis, ascending and positive, Hz. */
  freqsHz: number[];
  /** Time axis, ascending, ms — one entry per slice. */
  timesMs: number[];
  /** SPL in dB, indexed [timeSlice][frequency]. */
  splByTime: number[][];
}

export interface BandDecay {
  band: string;
  lowHz: number;
  highHz: number;
  /** Mean time (ms) for SPL to fall the drop threshold across the band, or null if the band is uncovered. */
  decayMs: number | null;
}

export interface RingingMode {
  hz: number;
  /** This frequency's decay time (ms); capped at the surface's time span if it never fully decays. */
  decayMs: number;
  /** How much longer this frequency rings than its local-median neighbours, ms. */
  excessMs: number;
  severity: "severe" | "moderate" | "minor";
}

export interface DecaySummary {
  rangeHz: [number, number];
  timeSpanMs: number;
  sliceCount: number;
  /** SPL drop (dB) the decay time is measured to. */
  dropDb: number;
  bands: BandDecay[];
  ringingModes: RingingMode[];
}

const BANDS: ReadonlyArray<readonly [string, number, number]> = [
  ["sub-bass", 20, 60],
  ["bass", 60, 250],
  ["low-mid", 250, 500],
  ["mid", 500, 2000],
  ["high-mid", 2000, 6000],
  ["treble", 6000, 20000],
];

const round = (value: number, places = 1): number => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

/**
 * Time (ms) for the SPL at one frequency to fall `dropDb` below its initial (t=0)
 * level. Interpolates linearly between the bracketing slices. When it never falls
 * that far within the captured span, returns the full time span — a lower bound on
 * the true decay, which is exactly what marks a slow, ringing mode.
 */
export function decayTimeMs(surface: DecaySurface, freqIndex: number, dropDb: number): number {
  const { timesMs, splByTime } = surface;
  const initial = splByTime[0][freqIndex];
  const target = initial - dropDb;
  for (let t = 1; t < timesMs.length; t++) {
    const s0 = splByTime[t - 1][freqIndex];
    const s1 = splByTime[t][freqIndex];
    if (s1 <= target) {
      // Fraction of this step at which SPL crosses the target (s0 > target >= s1).
      const frac = s0 === s1 ? 0 : (s0 - target) / (s0 - s1);
      return timesMs[t - 1] + frac * (timesMs[t] - timesMs[t - 1]);
    }
  }
  return timesMs[timesMs.length - 1] - timesMs[0];
}

/**
 * Median decay time over a ±windowOctaves/2 frequency window around each point —
 * the local baseline a ringing mode stands proud of. Median, not mean, so one slow
 * mode barely moves its own baseline. Mirrors spectrum.ts's localBaseline.
 */
export function localMedianDecay(
  freqsHz: ArrayLike<number>,
  decayMs: ArrayLike<number>,
  windowOctaves: number,
): Float64Array {
  if (!(windowOctaves > 0)) {
    // [LAW:no-silent-failure] a non-positive window inverts the frequency range so
    // every window is empty, and an empty median is NaN — reject it, don't emit NaN.
    throw new Error(`windowOctaves must be positive, got ${windowOctaves}`);
  }
  const n = freqsHz.length;
  const out = new Float64Array(n);
  const halfRatio = 2 ** (windowOctaves / 2);
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < n; i++) {
    const lowHz = freqsHz[i] / halfRatio;
    const highHz = freqsHz[i] * halfRatio;
    while (hi < n && freqsHz[hi] <= highHz) hi++;
    while (lo < hi && freqsHz[lo] < lowHz) lo++;
    const window = Array.prototype.slice.call(decayMs, lo, hi).sort((a: number, b: number) => a - b);
    const mid = window.length >> 1;
    out[i] = window.length % 2 === 1 ? window[mid] : (window[mid - 1] + window[mid]) / 2;
  }
  return out;
}

export interface RingingOptions {
  /** Octave span of the median-baseline window the excess is measured against. */
  windowOctaves?: number;
  /** Minimum excess decay (ms) over the local median for a frequency to count as ringing. */
  minExcessMs?: number;
  /** Keep at most this many modes, largest excess first. */
  maxCount?: number;
}

function severityOf(excessMs: number): RingingMode["severity"] {
  if (excessMs >= 200) return "severe";
  if (excessMs >= 100) return "moderate";
  return "minor";
}

/**
 * Frequencies that ring — whose decay time exceeds the local-median baseline of
 * their neighbours by more than `minExcessMs`. Local maxima of the excess, with
 * nearby weaker peaks within 1/3 octave suppressed, mirroring detectExtrema.
 */
export function detectRingingModes(
  surface: DecaySurface,
  dropDb: number,
  options: RingingOptions = {},
): RingingMode[] {
  const { windowOctaves = 1, minExcessMs = 50, maxCount = 12 } = options;
  const freqsHz = surface.freqsHz;
  const n = freqsHz.length;
  // Need at least three frequencies to have an interior local maximum, and at least
  // two time slices for decayTimeMs to bracket a decay. [LAW:no-defensive-null-guards]
  // the guard reflects the real precondition rather than papering over an empty surface.
  if (n < 3 || surface.timesMs.length < 2) return [];
  const decay = new Float64Array(n);
  for (let i = 0; i < n; i++) decay[i] = decayTimeMs(surface, i, dropDb);
  const baseline = localMedianDecay(freqsHz, decay, windowOctaves);
  const excess = new Float64Array(n);
  for (let i = 0; i < n; i++) excess[i] = decay[i] - baseline[i];

  const candidates: number[] = [];
  for (let i = 1; i < n - 1; i++) {
    if (excess[i] < minExcessMs) continue;
    if (excess[i] >= excess[i - 1] && excess[i] >= excess[i + 1]) candidates.push(i);
  }
  candidates.sort((a, b) => excess[b] - excess[a]);

  const kept: number[] = [];
  for (const index of candidates) {
    const tooClose = kept.some((other) => Math.abs(Math.log2(freqsHz[index] / freqsHz[other])) < 1 / 3);
    if (!tooClose) kept.push(index);
    if (kept.length >= maxCount) break;
  }

  return kept
    .sort((a, b) => freqsHz[a] - freqsHz[b])
    .map((index) => ({
      hz: round(freqsHz[index]),
      decayMs: round(decay[index]),
      excessMs: round(excess[index]),
      severity: severityOf(excess[index]),
    }));
}

/**
 * Reduce a decay surface to per-band decay times and ringing modes — the LLM-sized
 * rendering of a waterfall. Never returns raw slices.
 */
export function summarizeDecay(
  surface: DecaySurface,
  options: { dropDb?: number } & RingingOptions = {},
): DecaySummary {
  const { dropDb = 20, ...ringing } = options;
  const { freqsHz, timesMs } = surface;
  if (freqsHz.length === 0 || timesMs.length < 2) {
    throw new Error("cannot summarize an empty or single-slice decay surface");
  }
  const decay = freqsHz.map((_, i) => decayTimeMs(surface, i, dropDb));

  const bands: BandDecay[] = BANDS.map(([band, lowHz, highHz]) => {
    let sum = 0;
    let count = 0;
    for (let i = 0; i < freqsHz.length; i++) {
      if (freqsHz[i] >= lowHz && freqsHz[i] < highHz) {
        sum += decay[i];
        count++;
      }
    }
    return { band, lowHz, highHz, decayMs: count > 0 ? round(sum / count) : null };
  });

  return {
    rangeHz: [round(freqsHz[0]), round(freqsHz[freqsHz.length - 1])],
    timeSpanMs: round(timesMs[timesMs.length - 1] - timesMs[0]),
    sliceCount: timesMs.length,
    dropDb,
    bands,
    ringingModes: detectRingingModes(surface, dropDb, ringing),
  };
}
