// [LAW:parse-dont-validate] This module is the border checkpoint for REW wire data.
// Raw JSON crosses exactly once, here, and leaves stamped as a typed object;
// nothing downstream re-checks shapes. Schemas are loose objects because REW
// adds fields across versions — unknown extras pass through, known fields are typed.

import { z } from "zod";
import { decodeFloats } from "./codec.js";

export const measurementSummarySchema = z.looseObject({
  uuid: z.string(),
  title: z.string().optional(),
  notes: z.string().optional(),
  date: z.string().optional(),
  startFreq: z.number().optional(),
  endFreq: z.number().optional(),
  sampleRate: z.number().optional(),
  timingReference: z.string().optional(),
  delay: z.number().optional(),
  signalToNoisedB: z.number().optional(),
  groupName: z.string().optional(),
  groupUuid: z.string().optional(),
});
export type MeasurementSummary = z.output<typeof measurementSummarySchema>;

/** GET /measurements returns an object keyed by 1-based index string, not an array. */
export const measurementListSchema = z.record(z.string(), measurementSummarySchema);

export interface IndexedMeasurement extends MeasurementSummary {
  index: number;
}

export function toIndexedList(list: z.output<typeof measurementListSchema>): IndexedMeasurement[] {
  return Object.entries(list)
    .map(([index, summary]) => ({ ...summary, index: Number(index) }))
    .sort((a, b) => a.index - b.index);
}

const frequencyResponseWireSchema = z.looseObject({
  unit: z.string().optional(),
  smoothing: z.string().optional(),
  startFreq: z.number(),
  ppo: z.number().optional(),
  freqStep: z.number().optional(),
  magnitude: z.string(),
  phase: z.string().optional(),
});

/**
 * A frequency response with the wire encoding already resolved: base64 decoded
 * and the frequency axis materialised from startFreq + (ppo | freqStep).
 * Holding decoded arrays is the stamp — code receiving a Spectrum never sees base64.
 */
export interface Spectrum {
  freqsHz: Float64Array;
  magDb: Float64Array;
  phaseDeg: Float64Array | undefined;
  unit: string | undefined;
  smoothing: string | undefined;
}

export const spectrumSchema = frequencyResponseWireSchema.transform((wire, ctx): Spectrum => {
  const magDb = decodeFloats(wire.magnitude);
  const freqsHz = new Float64Array(magDb.length);
  if (wire.ppo !== undefined && wire.ppo > 0) {
    const ratio = Math.LN2 / wire.ppo;
    for (let i = 0; i < freqsHz.length; i++) freqsHz[i] = wire.startFreq * Math.exp(i * ratio);
  } else if (wire.freqStep !== undefined && wire.freqStep > 0) {
    for (let i = 0; i < freqsHz.length; i++) freqsHz[i] = wire.startFreq + i * wire.freqStep;
  } else {
    // [LAW:no-silent-failure] without a spacing rule the axis would be fiction
    ctx.addIssue({ code: "custom", message: "frequency response has neither ppo nor freqStep" });
    return z.NEVER;
  }
  return {
    freqsHz,
    magDb,
    phaseDeg: wire.phase !== undefined ? decodeFloats(wire.phase) : undefined,
    unit: wire.unit,
    smoothing: wire.smoothing,
  };
});

export const splValuesSchema = z.looseObject({
  meterNumber: z.number().optional(),
  weighting: z.string().optional(),
  filter: z.string().optional(),
  spl: z.number().optional(),
  leq: z.number().optional(),
  sel: z.number().optional(),
  elapsedTime: z.number().optional(),
});
export type SplValues = z.output<typeof splValuesSchema>;

export const filterSettingSchema = z.looseObject({
  index: z.number().optional(),
  type: z.string().optional(),
  enabled: z.boolean().optional(),
  frequency: z.number().optional(),
  // REW's wire field is `gaindB` for both reads and writes — a `gain` field is
  // silently ignored on write and absent on read. [LAW:one-source-of-truth]
  gaindB: z.number().optional(),
  q: z.number().optional(),
});
export type FilterSetting = z.output<typeof filterSettingSchema>;

export const filterListSchema = z.array(filterSettingSchema);

/** RT60 endpoint: map of band centre frequency -> ISO 3382 parameter map (0 = full band). */
export const rt60Schema = z.record(z.string(), z.record(z.string(), z.unknown()));

export const distortionSchema = z.looseObject({
  type: z.string().optional(),
  columnHeaders: z.array(z.string()).optional(),
  data: z.array(z.array(z.number().nullable())).optional(),
});

export const groupInfoSchema = z.looseObject({
  // Groups are addressed by UUID only (names are user-editable), and every
  // GroupInfo REW returns carries one — so the stamp requires it.
  uuid: z.string(),
  name: z.string().optional(),
  notes: z.string().optional(),
});
export type GroupInfo = z.output<typeof groupInfoSchema>;

/**
 * [LAW:one-type-per-behavior] Some REW collection endpoints answer an array,
 * others an index-keyed record (see measurementListSchema); the group endpoints'
 * choice is not documented. Accept either and stamp a plain array — integer-like
 * record keys enumerate in ascending order, preserving REW's ordering.
 */
const arrayOrIndexed = <S extends z.ZodType>(item: S) =>
  z
    .union([z.array(item), z.record(z.string(), item)])
    .transform((wire): Array<z.output<S>> => (Array.isArray(wire) ? wire : Object.values(wire)));

export const groupListSchema = arrayOrIndexed(groupInfoSchema);

/** GET /groups/:uuid/measurements — summaries of the group's members. */
export const groupMeasurementsSchema = arrayOrIndexed(measurementSummarySchema);

/** For endpoints whose payload we relay verbatim (command lists, errors, process results). */
export const unknownSchema = z.unknown();

/** Scalar endpoints (e.g. /alignment-tool/delay-b) answer a bare number or its string form. */
export const wireNumberSchema = z.coerce.number();
