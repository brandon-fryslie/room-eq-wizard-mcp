// [LAW:effects-at-boundaries] Pure spectrum analysis: typed arrays in, findings out.
// Nothing here touches REW, the network, or the clock — every function is
// unit-testable with literal arrays and no mocks.
//
// This layer exists because a measured response at 96 PPO is thousands of points:
// far too much for an LLM context, and raw points are not insight anyway. The
// contract is reduction: band statistics, detected peaks/nulls with Q, and
// log-decimated curves small enough to read.

export interface SpectrumPoint {
  hz: number;
  db: number;
}

export interface Extremum {
  kind: "peak" | "null";
  hz: number;
  db: number;
  /** Signed deviation from the local (±window/2 octave) median baseline, dB. */
  deviationDb: number;
  /** Centre frequency / -3 dB bandwidth; null when the response never falls 3 dB within range. */
  q: number | null;
  severity: "severe" | "moderate" | "minor";
}

export interface BandStat {
  band: string;
  lowHz: number;
  highHz: number;
  /** Mean level in dB, or null when the measurement does not cover the band. */
  meanDb: number | null;
}

export interface SpectrumSummary {
  rangeHz: [number, number];
  pointCount: number;
  meanDb: number;
  /** Standard deviation of level across the range — a flatness figure. */
  stdDevDb: number;
  min: SpectrumPoint;
  max: SpectrumPoint;
  bands: BandStat[];
  peaks: Extremum[];
  nulls: Extremum[];
}

const BANDS: ReadonlyArray<readonly [string, number, number]> = [
  ["sub-bass", 20, 60],
  ["bass", 60, 250],
  ["low-mid", 250, 500],
  ["mid", 500, 2000],
  ["high-mid", 2000, 6000],
  ["treble", 6000, 20000],
];

const round = (value: number, places = 2): number => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

function severityOf(deviationDb: number): Extremum["severity"] {
  const magnitude = Math.abs(deviationDb);
  if (magnitude >= 10) return "severe";
  if (magnitude >= 6) return "moderate";
  return "minor";
}

/**
 * Baseline level at each point: the median over a ±windowOctaves/2 window.
 * Median, not mean — a narrow peak or null barely moves the median, so the
 * deviation measures the feature's true height and the feature's own energy
 * cannot manufacture phantom opposite-sign "shoulders" beside it.
 */
export function localBaseline(
  freqsHz: ArrayLike<number>,
  magDb: ArrayLike<number>,
  windowOctaves: number,
): Float64Array {
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
    const window = Array.prototype.slice.call(magDb, lo, hi).sort((a: number, b: number) => a - b);
    const mid = window.length >> 1;
    out[i] = window.length % 2 === 1 ? window[mid] : (window[mid - 1] + window[mid]) / 2;
  }
  return out;
}

export interface ExtremaOptions {
  /** Octave span of the median-baseline window the deviation is measured against. */
  windowOctaves?: number;
  /** Minimum |deviation| in dB for a point to count as a peak or null. */
  minDeviationDb?: number;
  /** Keep at most this many extrema, largest deviation first. */
  maxCount?: number;
}

/**
 * Detect peaks and nulls as local extrema of the deviation from a smoothed
 * baseline. Nearby ripple around one feature is suppressed: within 1/3 octave
 * of a stronger extremum of the same kind, weaker candidates are dropped.
 */
export function detectExtrema(
  freqsHz: ArrayLike<number>,
  magDb: ArrayLike<number>,
  options: ExtremaOptions = {},
): Extremum[] {
  const { windowOctaves = 1, minDeviationDb = 3, maxCount = 12 } = options;
  const n = freqsHz.length;
  if (n < 3) return [];
  const baseline = localBaseline(freqsHz, magDb, windowOctaves);
  const deviation = new Float64Array(n);
  for (let i = 0; i < n; i++) deviation[i] = magDb[i] - baseline[i];

  const candidates: number[] = [];
  for (let i = 1; i < n - 1; i++) {
    const d = deviation[i];
    if (Math.abs(d) < minDeviationDb) continue;
    const isPeak = d > 0 && d >= deviation[i - 1] && d >= deviation[i + 1];
    const isNull = d < 0 && d <= deviation[i - 1] && d <= deviation[i + 1];
    if (isPeak || isNull) candidates.push(i);
  }

  candidates.sort((a, b) => Math.abs(deviation[b]) - Math.abs(deviation[a]));
  const kept: number[] = [];
  for (const index of candidates) {
    const tooClose = kept.some(
      (other) =>
        Math.sign(deviation[other]) === Math.sign(deviation[index]) &&
        Math.abs(Math.log2(freqsHz[index] / freqsHz[other])) < 1 / 3,
    );
    if (!tooClose) kept.push(index);
    if (kept.length >= maxCount) break;
  }

  return kept
    .sort((a, b) => freqsHz[a] - freqsHz[b])
    .map((index) => {
      const d = deviation[index];
      return {
        kind: d > 0 ? ("peak" as const) : ("null" as const),
        hz: round(freqsHz[index], 1),
        db: round(magDb[index]),
        deviationDb: round(d),
        q: estimateQ(freqsHz, deviation, index),
        severity: severityOf(d),
      };
    });
}

/** Q from the -3 dB (relative to the extremum's deviation) crossings on each side. */
function estimateQ(
  freqsHz: ArrayLike<number>,
  deviation: Float64Array,
  index: number,
): number | null {
  const target = Math.abs(deviation[index]) - 3;
  const sign = Math.sign(deviation[index]);
  let left: number | null = null;
  for (let i = index - 1; i >= 0; i--) {
    if (sign * deviation[i] <= target) {
      left = freqsHz[i + 1];
      break;
    }
  }
  let right: number | null = null;
  for (let i = index + 1; i < deviation.length; i++) {
    if (sign * deviation[i] <= target) {
      right = freqsHz[i - 1];
      break;
    }
  }
  if (left === null || right === null || right <= left) return null;
  return round(freqsHz[index] / (right - left), 1);
}

export function summarizeSpectrum(
  freqsHz: ArrayLike<number>,
  magDb: ArrayLike<number>,
  options: ExtremaOptions = {},
): SpectrumSummary {
  const n = freqsHz.length;
  if (n === 0) throw new Error("cannot summarize an empty spectrum");

  let sum = 0;
  let sumSq = 0;
  let minIndex = 0;
  let maxIndex = 0;
  for (let i = 0; i < n; i++) {
    sum += magDb[i];
    sumSq += magDb[i] * magDb[i];
    if (magDb[i] < magDb[minIndex]) minIndex = i;
    if (magDb[i] > magDb[maxIndex]) maxIndex = i;
  }
  const mean = sum / n;
  const variance = Math.max(0, sumSq / n - mean * mean);

  const bands: BandStat[] = BANDS.map(([band, lowHz, highHz]) => {
    let bandSum = 0;
    let count = 0;
    for (let i = 0; i < n; i++) {
      if (freqsHz[i] >= lowHz && freqsHz[i] < highHz) {
        bandSum += magDb[i];
        count++;
      }
    }
    return { band, lowHz, highHz, meanDb: count > 0 ? round(bandSum / count) : null };
  });

  const extrema = detectExtrema(freqsHz, magDb, options);
  return {
    rangeHz: [round(freqsHz[0], 1), round(freqsHz[n - 1], 1)],
    pointCount: n,
    meanDb: round(mean),
    stdDevDb: round(Math.sqrt(variance)),
    min: { hz: round(freqsHz[minIndex], 1), db: round(magDb[minIndex]) },
    max: { hz: round(freqsHz[maxIndex], 1), db: round(magDb[maxIndex]) },
    bands,
    peaks: extrema.filter((e) => e.kind === "peak"),
    nulls: extrema.filter((e) => e.kind === "null"),
  };
}

/**
 * Reduce a spectrum to at most maxPoints log-spaced points by averaging each
 * bin — the reader-sized rendering of a curve, not an analysis.
 */
export function decimateLog(
  freqsHz: ArrayLike<number>,
  magDb: ArrayLike<number>,
  maxPoints: number,
): SpectrumPoint[] {
  const n = freqsHz.length;
  if (n === 0) return [];
  if (n <= maxPoints) {
    return Array.from({ length: n }, (_, i) => ({
      hz: round(freqsHz[i], 1),
      db: round(magDb[i]),
    }));
  }
  const logMin = Math.log(freqsHz[0]);
  const logMax = Math.log(freqsHz[n - 1]);
  const points: SpectrumPoint[] = [];
  let start = 0;
  for (let bin = 0; bin < maxPoints; bin++) {
    const upperHz = Math.exp(logMin + ((bin + 1) * (logMax - logMin)) / maxPoints);
    let sumDb = 0;
    let sumLogHz = 0;
    let count = 0;
    while (start < n && (freqsHz[start] <= upperHz || bin === maxPoints - 1)) {
      sumDb += magDb[start];
      sumLogHz += Math.log(freqsHz[start]);
      count++;
      start++;
    }
    if (count > 0) {
      points.push({ hz: round(Math.exp(sumLogHz / count), 1), db: round(sumDb / count) });
    }
  }
  return points;
}

/**
 * A minus B on A's frequency grid, using log-frequency linear interpolation of
 * B, restricted to the overlap of the two ranges.
 */
export function diffSpectra(
  a: { freqsHz: ArrayLike<number>; magDb: ArrayLike<number> },
  b: { freqsHz: ArrayLike<number>; magDb: ArrayLike<number> },
): { freqsHz: Float64Array; magDb: Float64Array } {
  const lowHz = Math.max(a.freqsHz[0], b.freqsHz[0]);
  const highHz = Math.min(a.freqsHz[a.freqsHz.length - 1], b.freqsHz[b.freqsHz.length - 1]);
  if (!(lowHz < highHz)) {
    // [LAW:no-silent-failure] disjoint ranges are a caller error, not an empty answer
    throw new Error(
      `measurements do not overlap in frequency (A covers ${a.freqsHz[0]}–${a.freqsHz[a.freqsHz.length - 1]} Hz, ` +
        `B covers ${b.freqsHz[0]}–${b.freqsHz[b.freqsHz.length - 1]} Hz)`,
    );
  }
  const freqs: number[] = [];
  const diffs: number[] = [];
  let j = 0;
  for (let i = 0; i < a.freqsHz.length; i++) {
    const hz = a.freqsHz[i];
    if (hz < lowHz || hz > highHz) continue;
    while (j < b.freqsHz.length - 1 && b.freqsHz[j + 1] < hz) j++;
    const f0 = b.freqsHz[j];
    const f1 = b.freqsHz[Math.min(j + 1, b.freqsHz.length - 1)];
    const t = f1 > f0 ? (Math.log(hz) - Math.log(f0)) / (Math.log(f1) - Math.log(f0)) : 0;
    const bDb = b.magDb[j] + t * (b.magDb[Math.min(j + 1, b.magDb.length - 1)] - b.magDb[j]);
    freqs.push(hz);
    diffs.push(a.magDb[i] - bDb);
  }
  return { freqsHz: Float64Array.from(freqs), magDb: Float64Array.from(diffs) };
}
