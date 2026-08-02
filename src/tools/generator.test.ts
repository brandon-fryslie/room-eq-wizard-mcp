import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { RewClient } from "../rew/client.js";
import { stubFetch, type FetchCall } from "../rew/fetch-stub.js";
import { allTools } from "./index.js";

async function invoke(name: string, client: RewClient, args: Record<string, unknown> = {}) {
  const tool = allTools.find((t) => t.name === name);
  if (tool === undefined) throw new Error(`no tool named ${name}`);
  return tool.handler(client, z.object(tool.inputSchema).parse(args));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const postBody = (calls: FetchCall[], path: string) =>
  calls.find((c) => c.method === "POST" && new URL(c.url).pathname === path)?.body;

describe("generator", () => {
  it("posts invert-second-output as a bare boolean", async () => {
    const { calls } = stubFetch([{}, { body: { enabled: true } }]);
    await invoke("generator", new RewClient(), { invertSecondOutput: true });
    expect(postBody(calls, "/generator/invert-second-output")).toBe(true);
  });
});

describe("list_generator_signals", () => {
  it("reads the generator signal list", async () => {
    stubFetch([{ body: ["sine", "pinknoise", "multitone"] }]);
    const result = await invoke("list_generator_signals", new RewClient());
    expect(result).toEqual(["sine", "pinknoise", "multitone"]);
  });
});

describe("set_generator_protection", () => {
  it("merges provided protection fields over current and returns the result", async () => {
    const { calls } = stubFetch([
      { body: { clippingAbort: true, splLimitAbort: false, dBSPLLimit: 100 } }, // current
      {}, // POST
      { body: { clippingAbort: true, splLimitAbort: true, dBSPLLimit: 95 } }, // re-read
    ]);
    const result = await invoke("set_generator_protection", new RewClient(), {
      splLimitAbort: true,
      dBSPLLimit: 95,
    });
    expect(postBody(calls, "/generator/protection")).toEqual({
      clippingAbort: true,
      splLimitAbort: true,
      dBSPLLimit: 95,
    });
    expect(result).toMatchObject({ dBSPLLimit: 95 });
  });

  it("reads protection when no fields are provided (no POST)", async () => {
    const { calls } = stubFetch([{ body: { clippingAbort: true } }]);
    const result = await invoke("set_generator_protection", new RewClient());
    expect(calls.every((c) => c.method === "GET")).toBe(true);
    expect(result).toEqual({ clippingAbort: true });
  });
});
