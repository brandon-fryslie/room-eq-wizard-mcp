import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { RewApiError, RewClient } from "./client.js";
import { stubFetch } from "./fetch-stub.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("RewClient", () => {
  it("parses GET responses through the given schema", async () => {
    stubFetch([{ body: { spl: 82.5 } }]);
    const client = new RewClient();
    const result = await client.get("/spl-meter/1/levels", z.object({ spl: z.number() }));
    expect(result.spl).toBe(82.5);
  });

  it("rejects wire data that fails the schema", async () => {
    stubFetch([{ body: { spl: "loud" } }]);
    const client = new RewClient();
    await expect(client.get("/spl-meter/1/levels", z.object({ spl: z.number() }))).rejects.toThrow();
  });

  it("appends only defined query parameters", async () => {
    const { calls } = stubFetch([{ body: {} }]);
    const client = new RewClient();
    await client.get("/x", z.unknown(), { ppo: 96, smoothing: undefined });
    expect(calls[0].url).toContain("ppo=96");
    expect(calls[0].url).not.toContain("smoothing");
  });

  it("maps HTTP errors to RewApiError with status and body", async () => {
    stubFetch([{ status: 400, body: { message: "A command is already running" } }]);
    const client = new RewClient();
    const error = await client.post("/measure/command", { command: "SPL" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RewApiError);
    expect((error as RewApiError).status).toBe(400);
    expect((error as RewApiError).message).toContain("already running");
  });

  it("treats 202 Accepted as success, not error", async () => {
    stubFetch([{ status: 202, body: { message: "started" } }]);
    const client = new RewClient();
    await expect(client.post("/x", {})).resolves.toEqual({ message: "started" });
  });

  it("maps network failure to an actionable connection error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    const client = new RewClient();
    const error = await client.get("/measurements", z.unknown()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RewApiError);
    expect((error as RewApiError).message).toContain("-api");
  });

  it("enables blocking mode exactly once before commands", async () => {
    const { calls } = stubFetch([{ body: "" }]);
    const client = new RewClient();
    await client.command("/measure/command", { command: "SPL" });
    await client.command("/measurements/command", { command: "Save all", parameters: ["a"] });
    const blockingCalls = calls.filter((c) => c.url.endsWith("/application/blocking"));
    expect(blockingCalls.length).toBe(1);
    expect(blockingCalls[0].body).toBe(true);
    // Blocking was enabled before the first command was sent.
    expect(calls[0].url).toContain("/application/blocking");
    expect(calls[1].url).toContain("/measure/command");
  });

  it("returns bare-string responses as strings", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not json", { status: 200 })),
    );
    const client = new RewClient();
    await expect(client.get("/import/frequency-response", z.string())).resolves.toBe("not json");
  });
});
