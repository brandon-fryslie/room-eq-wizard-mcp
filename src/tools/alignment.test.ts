import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { RewClient } from "../rew/client.js";
import { stubFetch } from "../rew/fetch-stub.js";
import { allTools } from "./index.js";

// [LAW:behavior-not-structure] these tests assert the wire contract — which
// endpoints receive which bodies in which order — never the handlers' internals.
// Args pass through the tool's own Zod shape first, exactly as the MCP layer does.
async function invoke(name: string, client: RewClient, args: Record<string, unknown> = {}) {
  const tool = allTools.find((t) => t.name === name);
  if (tool === undefined) throw new Error(`no tool named ${name}`);
  return tool.handler(client, z.object(tool.inputSchema).parse(args));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("align_measurements", () => {
  it("configures the pair, runs Align phase, and reports the coerced delay", async () => {
    const { calls } = stubFetch([
      {}, // index-a
      {}, // index-b
      {}, // mode
      {}, // invert-b
      {}, // blocking
      { body: { message: "aligned" } }, // command
      { body: "1.5" }, // delay-b
    ]);
    const client = new RewClient();
    const result = await invoke("align_measurements", client, {
      measurementA: "2",
      measurementB: "5",
      frequencyHz: 100,
    });

    const posts = calls.filter((c) => c.method === "POST");
    expect(posts.map((c) => [new URL(c.url).pathname, c.body])).toEqual([
      ["/alignment-tool/index-a", 2],
      ["/alignment-tool/index-b", 5],
      ["/alignment-tool/mode", "Phase"],
      ["/alignment-tool/invert-b", false],
      ["/application/blocking", true],
      ["/alignment-tool/command", { command: "Align phase", frequency: 100 }],
    ]);
    expect(calls.at(-1)?.url).toContain("/alignment-tool/delay-b");
    expect(result).toMatchObject({ delayBMs: 1.5, invertB: false, frequencyHz: 100 });
  });

  it("resolves UUID references to indices via the measurement list", async () => {
    const measurementList = { "1": { uuid: "aaa" }, "2": { uuid: "bbb" } };
    const { calls } = stubFetch([
      { body: measurementList }, // resolve A
      { body: measurementList }, // resolve B
      {}, // index-a
      {}, // index-b
      {}, // mode
      {}, // invert-b
      {}, // max-positive-delay
      {}, // blocking
      { body: { message: "aligned" } }, // command
      { body: 0.25 }, // delay-b
    ]);
    const client = new RewClient();
    await invoke("align_measurements", client, {
      measurementA: "bbb",
      measurementB: "aaa",
      maxPositiveDelayMs: 20,
    });
    const posts = calls.filter((c) => c.method === "POST");
    expect(posts.map((c) => [new URL(c.url).pathname, c.body])).toEqual([
      ["/alignment-tool/index-a", 2],
      ["/alignment-tool/index-b", 1],
      ["/alignment-tool/mode", "Phase"],
      ["/alignment-tool/invert-b", false],
      ["/alignment-tool/max-positive-delay", 20],
      ["/application/blocking", true],
      ["/alignment-tool/command", { command: "Align phase", frequency: 80 }],
    ]);
  });

  it("fails loudly on an unknown UUID instead of aligning the wrong pair", async () => {
    stubFetch([{ body: { "1": { uuid: "aaa" } } }]);
    const client = new RewClient();
    await expect(
      invoke("align_measurements", client, { measurementA: "nope", measurementB: "aaa" }),
    ).rejects.toThrow(/no measurement with UUID nope/);
  });
});

describe("create_aligned_sum", () => {
  it("sends the Aligned sum command and reports the newest measurement", async () => {
    const { calls } = stubFetch([
      {}, // blocking
      {}, // command
      { body: { "1": { uuid: "aaa", title: "Sub" }, "2": { uuid: "sum", title: "Aligned sum" } } },
    ]);
    const client = new RewClient();
    const result = await invoke("create_aligned_sum", client);
    const command = calls.find((c) => c.url.includes("/alignment-tool/command"));
    expect(command?.body).toEqual({ command: "Aligned sum" });
    expect(result).toMatchObject({ newestMeasurement: { uuid: "sum", index: 2 } });
  });
});

describe("configure_alignment", () => {
  it("writes only the provided knobs, then returns the read-back state", async () => {
    const { calls } = stubFetch([{ body: 0 }]);
    const client = new RewClient();
    await invoke("configure_alignment", client, { mode: "Impulse", gainBDb: -3 });
    const posts = calls.filter((c) => c.method === "POST");
    expect(posts.map((c) => [new URL(c.url).pathname, c.body])).toEqual([
      ["/alignment-tool/mode", "Impulse"],
      ["/alignment-tool/gain-b", -3],
    ]);
    // Read-back covers every state endpoint.
    const reads = calls.filter((c) => c.method === "GET");
    expect(reads.length).toBe(12);
  });

  it("rejects a call that changes nothing", async () => {
    stubFetch([{}]);
    const client = new RewClient();
    await expect(invoke("configure_alignment", client)).rejects.toThrow(/at least one/);
  });
});

describe("run_alignment_command", () => {
  it("merges parameters into the command body at the top level", async () => {
    const { calls } = stubFetch([{}, { body: { message: "ok" } }]);
    const client = new RewClient();
    await invoke("run_alignment_command", client, {
      command: "Align IRs at cursor",
      parameters: { frequency: 120 },
    });
    const command = calls.find((c) => c.url.includes("/alignment-tool/command"));
    expect(command?.body).toEqual({ command: "Align IRs at cursor", frequency: 120 });
  });
});
