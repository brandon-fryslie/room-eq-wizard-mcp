// Shared REW fetch recipes used by multiple tools — each exists so the
// endpoint + schema pairing lives in exactly one place. [LAW:one-source-of-truth]

import { z } from "zod";
import type { RewClient } from "../rew/client.js";
import {
  measurementListSchema,
  spectrumSchema,
  toIndexedList,
  unknownSchema,
  type IndexedMeasurement,
  type Spectrum,
} from "../rew/types.js";

/**
 * Read-merge-write for REW's single-object settings endpoints (EQ match/room-curve
 * settings, IR windows): to change one field REW wants the whole object, so read it,
 * merge the provided fields, write, and return the fresh state. With no fields it is
 * a plain read. The write verb differs by endpoint (POST vs PUT). [LAW:single-enforcer]
 * the merge strategy lives once here; callers supply only the endpoint and verb.
 */
export async function writeMergedSettings(
  client: RewClient,
  endpoint: string,
  settings: Record<string, unknown> | undefined,
  verb: "post" | "put" = "post",
): Promise<void> {
  if (settings !== undefined && Object.keys(settings).length > 0) {
    // Read as an object so the spread is sound — z.looseObject throws on a non-object
    // rather than a cast silently spreading garbage. [LAW:parse-dont-validate]
    const current = await client.get(endpoint, z.looseObject({}));
    await client[verb](endpoint, { ...current, ...settings });
  }
}

/** {@link writeMergedSettings} then a read of the fresh state — for callers whose
 *  result IS this endpoint. Callers that re-read a broader snapshot afterward should
 *  use writeMergedSettings directly to avoid a discarded GET. [LAW:effects-at-boundaries] */
export async function readMergeWriteSettings(
  client: RewClient,
  endpoint: string,
  settings: Record<string, unknown> | undefined,
  verb: "post" | "put" = "post",
): Promise<unknown> {
  await writeMergedSettings(client, endpoint, settings, verb);
  return client.get(endpoint, unknownSchema);
}

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
 * Snapshot the measurement list; the returned function reports which measurements
 * have appeared since. [LAW:one-source-of-truth] measurement identity is decided
 * here and nowhere else — both diffing callers below differ only in how often they
 * ask, never in what counts as new.
 */
async function measurementsAppearedSince(
  client: RewClient,
): Promise<() => Promise<IndexedMeasurement[]>> {
  const before = new Set((await listMeasurements(client)).map((m) => m.uuid));
  return async () => (await listMeasurements(client)).filter((m) => !before.has(m.uuid));
}

/**
 * Run an action that may make REW create measurements and report exactly the ones
 * that appeared. For commands REW completes before replying, and whose result may
 * legitimately be no new measurement at all (an EQ command that only rewrites
 * filters, an import of an empty file).
 *
 * When the caller requires a measurement, use {@link awaitMeasurementsCreatedBy}:
 * this one reads the list once and cannot see a measurement REW has not made yet.
 */
export async function measurementsCreatedBy<T>(
  client: RewClient,
  action: () => Promise<T>,
): Promise<{ result: T; created: IndexedMeasurement[] }> {
  const appeared = await measurementsAppearedSince(client);
  const result = await action();
  return { result, created: await appeared() };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run an action whose whole purpose is to produce measurements, and return them —
 * waiting until they actually exist, then proving it in the type.
 *
 * REW does not finish these before replying. /measure/command answers 202 Accepted
 * in ~50ms and sweeps on in the background *even with blocking mode enabled*
 * (verified live, REW 5.40 beta 132), so a single post-action read races the sweep
 * and sees either nothing or a previous measurement. Polling the uuid diff is the
 * only signal that actually reports completion.
 *
 * [LAW:parse-dont-validate] the non-empty tuple is the stamp: callers index it
 * without guarding, because "no measurement" cannot reach them.
 * [LAW:no-silent-failure] nothing by the deadline throws, naming the likely cause —
 * never a null or empty-array result wearing the shape of success.
 *
 * Two limits, both inherent to polling rather than oversights:
 *
 * It returns on the FIRST measurement this action created, so a Sequential or
 * Repeated run that publishes its channels one at a time can return before the
 * later ones exist. REW offers no read-only "measurement in progress" endpoint —
 * only /measure/subscribe (push, needs a callback URL) and the destructive probe of
 * firing a command to be told one is already running — so there is nothing to wait
 * on, and a settle window short enough to be cheap is too short to be correct when
 * channels are a sweep apart. Callers must not promise more than "at least one".
 *
 * Any measurement appearing in the window is attributed to this action, and the
 * window is now the command budget rather than one round trip. The precondition is
 * therefore that measurement-creating commands are serialized against a REW
 * instance — true of one agent driving one desktop REW, and the thing to fix with a
 * lock at the client if concurrent drivers ever become real.
 */
export async function awaitMeasurementsCreatedBy<T>(
  client: RewClient,
  action: () => Promise<T>,
  failureHint: string,
): Promise<{ result: T; created: [IndexedMeasurement, ...IndexedMeasurement[]] }> {
  const appeared = await measurementsAppearedSince(client);
  // Before the action, not after: the wait and the request share one budget, so a
  // command that nearly exhausts commandTimeoutMs before answering cannot then buy a
  // second full window of polling. [LAW:one-source-of-truth] one deadline, as
  // client.ts promises — computing it after `action()` made the caller-visible wait
  // up to twice the documented figure.
  const deadline = Date.now() + client.commandTimeoutMs;
  const result = await action();
  for (;;) {
    // Read before sleeping: a command REW *did* finish synchronously costs no delay.
    const [first, ...rest] = await appeared();
    if (first !== undefined) return { result, created: [first, ...rest] };
    if (Date.now() >= deadline) {
      throw new Error(
        `No new measurement appeared within ${Math.round(client.commandTimeoutMs / 1000)}s — ${failureHint}`,
      );
    }
    await delay(client.measurementPollIntervalMs);
  }
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
