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
