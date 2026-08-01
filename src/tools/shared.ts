// Shared REW fetch recipes used by multiple tools — each exists so the
// endpoint + schema pairing lives in exactly one place. [LAW:one-source-of-truth]

import type { RewClient } from "../rew/client.js";
import {
  measurementListSchema,
  spectrumSchema,
  toIndexedList,
  type IndexedMeasurement,
  type Spectrum,
} from "../rew/types.js";

export interface SpectrumQuery {
  smoothing?: string;
  ppo?: number;
  unit?: string;
}

export async function fetchSpectrum(
  client: RewClient,
  measurement: string,
  query: SpectrumQuery = {},
): Promise<Spectrum> {
  return client.get(
    `/measurements/${encodeURIComponent(measurement)}/frequency-response`,
    spectrumSchema,
    { smoothing: query.smoothing, ppo: query.ppo, unit: query.unit },
  );
}

export async function listMeasurements(client: RewClient): Promise<IndexedMeasurement[]> {
  const raw = await client.get("/measurements", measurementListSchema);
  return toIndexedList(raw);
}

/**
 * Resolve a UUID-or-index measurement reference to a proven 1-based index, for
 * REW endpoints that address measurements by index only (the alignment tool).
 * [LAW:parse-dont-validate] the returned number is the stamp; an unknown UUID
 * fails loudly here instead of selecting the wrong measurement downstream.
 */
export async function resolveIndex(client: RewClient, measurement: string): Promise<number> {
  if (/^\d+$/.test(measurement)) return Number(measurement);
  const found = (await listMeasurements(client)).find((m) => m.uuid === measurement);
  if (found === undefined) {
    throw new Error(`no measurement with UUID ${measurement} — see list_measurements`);
  }
  return found.index;
}

/**
 * Resolve a UUID-or-index measurement reference to its UUID, for REW payloads
 * that require a UUID (group membership). Mirror of resolveIndex.
 * [LAW:parse-dont-validate] an unknown index fails loudly here instead of
 * posting a fabricated UUID REW would reject with no hint of the cause.
 */
export async function resolveUuid(client: RewClient, measurement: string): Promise<string> {
  if (!/^\d+$/.test(measurement)) return measurement;
  const index = Number(measurement);
  const found = (await listMeasurements(client)).find((m) => m.index === index);
  if (found === undefined) {
    throw new Error(`no measurement at index ${measurement} — see list_measurements`);
  }
  return found.uuid;
}

/**
 * Run an action that makes REW create measurements (load, import, sweep) and
 * report exactly the ones that appeared, by diffing the measurement list.
 * [LAW:one-source-of-truth] the before/after diff lives once here; with the
 * client in blocking mode the action's HTTP response arrives only after the
 * measurements exist, so the diff is race-free.
 */
export async function measurementsCreatedBy<T>(
  client: RewClient,
  action: () => Promise<T>,
): Promise<{ result: T; created: IndexedMeasurement[] }> {
  const before = new Set((await listMeasurements(client)).map((m) => m.uuid));
  const result = await action();
  const created = (await listMeasurements(client)).filter((m) => !before.has(m.uuid));
  return { result, created };
}

/** The most recently added measurement — REW appends at the highest index. */
export async function newestMeasurement(client: RewClient): Promise<IndexedMeasurement | null> {
  const all = await listMeasurements(client);
  return all.length > 0 ? all[all.length - 1] : null;
}

/** Compact projection of a measurement summary for tool output. */
export function summarize(m: IndexedMeasurement): Record<string, unknown> {
  return {
    uuid: m.uuid,
    index: m.index,
    title: m.title,
    notes: m.notes || undefined,
    date: m.date,
    rangeHz: m.startFreq !== undefined && m.endFreq !== undefined ? [m.startFreq, m.endFreq] : undefined,
    group: m.groupName,
  };
}
