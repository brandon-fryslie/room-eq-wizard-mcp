// Test helper: a recording fetch stub with canned responses, shared by every
// suite that exercises wire behavior. [LAW:one-source-of-truth] the stub lives
// once here, not per test file.

import { vi } from "vitest";

export type FetchCall = { url: string; method: string; body: unknown };

/** Install a fetch stub that records calls and replays canned responses in order. */
export function stubFetch(
  responses: Array<{ status?: number; body?: unknown }>,
): { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  let index = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL | string, init?: RequestInit) => {
      calls.push({
        url: String(url),
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      const next = responses[Math.min(index++, responses.length - 1)];
      const status = next.status ?? 200;
      return new Response(next.body !== undefined ? JSON.stringify(next.body) : "", {
        status,
        statusText: String(status),
      });
    }),
  );
  return { calls };
}

/**
 * Like {@link stubFetch} but replays canned responses keyed by request pathname
 * instead of by call order — for handlers that read several endpoints, so the test
 * asserts value-per-endpoint and can't be broken by reordering the reads. An
 * unmapped path answers 404 so a missed endpoint fails loudly rather than silently.
 */
export function stubFetchByPath(
  byPath: Record<string, { status?: number; body?: unknown }>,
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
      const next = byPath[new URL(String(url)).pathname];
      if (next === undefined) {
        return new Response("", { status: 404, statusText: "404" });
      }
      const status = next.status ?? 200;
      return new Response(next.body !== undefined ? JSON.stringify(next.body) : "", {
        status,
        statusText: String(status),
      });
    }),
  );
  return { calls };
}
