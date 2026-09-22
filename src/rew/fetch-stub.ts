// Test helper: a recording fetch stub with canned responses, shared by every
// suite that exercises wire behavior. [LAW:one-source-of-truth] the stub lives
// once here, not per test file.

import { vi } from "vitest";
import { RewClient } from "./client.js";

/**
 * A client that polls with no delay, so measurement-waiting tests run in
 * milliseconds instead of waiting out the real 180s sweep budget. `budgetMs` is the
 * whole variable: 0 buys exactly one look (asserting the give-up path), anything
 * larger lets the poll loop turn (asserting that it waits).
 * [LAW:no-ambient-temporal-coupling] the deadline is injected, never slept through.
 */
export const pollingClient = (budgetMs: number) =>
  new RewClient({ commandTimeoutMs: budgetMs, measurementPollIntervalMs: 0 });

export type FetchCall = { url: string; method: string; body: unknown };

type CannedResponse = { status?: number; body?: unknown };

/**
 * The one recording-fetch installer. Both public stubs differ only in how they
 * pick the canned response for a request; the call recording and Response
 * construction live here once. [LAW:one-source-of-truth] `resolve` returning
 * undefined means "no canned response" and answers 404.
 */
function installRecordingFetch(
  resolve: (path: string, callIndex: number) => CannedResponse | undefined,
): { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL | string, init?: RequestInit) => {
      calls.push({
        url: String(url),
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      const next = resolve(new URL(String(url)).pathname, calls.length - 1);
      const status = next?.status ?? (next === undefined ? 404 : 200);
      return new Response(next?.body !== undefined ? JSON.stringify(next.body) : "", {
        status,
        statusText: String(status),
      });
    }),
  );
  return { calls };
}

/**
 * The general stub: you decide the response from the request's path and its index.
 * For handlers whose answer must *change* over repeated reads of one endpoint —
 * polling a measurement into existence — which neither by-order nor by-path can say.
 * [LAW:composability] the primitive the other two stubs are already built from.
 */
export function stubFetchWith(
  resolve: (path: string, callIndex: number) => CannedResponse | undefined,
): { calls: FetchCall[] } {
  return installRecordingFetch(resolve);
}

/** Install a fetch stub that records calls and replays canned responses in order. */
export function stubFetch(responses: CannedResponse[]): { calls: FetchCall[] } {
  // Past the end, the last response repeats — so a handler making N calls needs
  // only its distinct responses listed.
  return installRecordingFetch((_, index) => responses[Math.min(index, responses.length - 1)]);
}

/**
 * Like {@link stubFetch} but replays canned responses keyed by request pathname
 * instead of by call order — for handlers that read several endpoints, so the test
 * asserts value-per-endpoint and can't be broken by reordering the reads. An
 * unmapped path answers 404 so a missed endpoint fails loudly rather than silently.
 */
export function stubFetchByPath(
  byPath: Record<string, CannedResponse>,
): { calls: FetchCall[] } {
  return installRecordingFetch((path) => byPath[path]);
}
