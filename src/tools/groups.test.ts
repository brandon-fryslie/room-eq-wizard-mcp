import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { RewClient } from "../rew/client.js";
import { stubFetch, type FetchCall } from "../rew/fetch-stub.js";
import { allTools } from "./index.js";

// [LAW:behavior-not-structure] these tests assert the wire contract — which
// endpoints receive which bodies — never the handlers' internals. Args pass
// through the tool's own Zod shape first, exactly as the MCP layer does.
async function invoke(name: string, client: RewClient, args: Record<string, unknown> = {}) {
  const tool = allTools.find((t) => t.name === name);
  if (tool === undefined) throw new Error(`no tool named ${name}`);
  return tool.handler(client, z.object(tool.inputSchema).parse(args));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const wire = (calls: FetchCall[]) =>
  calls.map((c) => [c.method, new URL(c.url).pathname, c.body] as const);

describe("list_groups", () => {
  it("returns an array shape as-is", async () => {
    stubFetch([{ body: [{ uuid: "g1", name: "Left" }] }]);
    const result = await invoke("list_groups", new RewClient());
    expect(result).toEqual([{ uuid: "g1", name: "Left" }]);
  });

  it("normalises an index-keyed record shape to an ordered array", async () => {
    stubFetch([
      { body: { "2": { uuid: "g2", name: "Right" }, "1": { uuid: "g1", name: "Left" } } },
    ]);
    const result = await invoke("list_groups", new RewClient());
    expect(result).toEqual([
      { uuid: "g1", name: "Left" },
      { uuid: "g2", name: "Right" },
    ]);
  });
});

describe("create_group", () => {
  it("posts GroupInfo and returns the group REW answered, with its uuid", async () => {
    const { calls } = stubFetch([{ body: { uuid: "new-g", name: "Subs", notes: "LFE set" } }]);
    const result = await invoke("create_group", new RewClient(), {
      name: "Subs",
      notes: "LFE set",
    });
    expect(wire(calls)).toEqual([["POST", "/groups", { name: "Subs", notes: "LFE set" }]]);
    expect(result).toMatchObject({ uuid: "new-g", name: "Subs", addedCount: 0, added: [] });
  });

  it("resolves index references to UUIDs and posts each membership", async () => {
    const { calls } = stubFetch([
      { body: { uuid: "new-g", name: "Pair" } }, // create
      {}, // membership aaa (uuid passed through, no lookup)
      { body: { "1": { uuid: "aaa" }, "2": { uuid: "bbb" } } }, // resolve index 2
      {}, // membership bbb
    ]);
    const result = await invoke("create_group", new RewClient(), {
      name: "Pair",
      measurements: ["aaa", "2"],
    });
    expect(wire(calls).filter(([method]) => method === "POST")).toEqual([
      ["POST", "/groups", { name: "Pair" }],
      ["POST", "/groups/new-g/measurements", { uuid: "aaa" }],
      ["POST", "/groups/new-g/measurements", { uuid: "bbb" }],
    ]);
    expect(result).toMatchObject({ addedCount: 2, added: ["aaa", "bbb"] });
  });

  it("surfaces the created group's uuid when membership fails afterwards", async () => {
    stubFetch([
      { body: { uuid: "orphan-g", name: "Half" } }, // create succeeds
      { status: 404, body: "no such measurement" }, // membership fails
    ]);
    await expect(
      invoke("create_group", new RewClient(), { name: "Half", measurements: ["ghost"] }),
    ).rejects.toThrow(/created \(uuid orphan-g\) but adding measurements failed/);
  });
});

describe("update_group", () => {
  it("PUTs only the provided fields to the group's endpoint", async () => {
    const { calls } = stubFetch([{}]);
    await invoke("update_group", new RewClient(), { group: "g1", name: "Mains" });
    expect(wire(calls)).toEqual([["PUT", "/groups/g1", { name: "Mains" }]]);
  });

  it("rejects a no-op update before touching the wire", async () => {
    const { calls } = stubFetch([{}]);
    await expect(invoke("update_group", new RewClient(), { group: "g1" })).rejects.toThrow(
      /provide name, notes, or both/,
    );
    expect(calls).toHaveLength(0);
  });
});

describe("delete_group", () => {
  it("DELETEs the group's endpoint", async () => {
    const { calls } = stubFetch([{}]);
    await invoke("delete_group", new RewClient(), { group: "g1" });
    expect(wire(calls)).toEqual([["DELETE", "/groups/g1", undefined]]);
  });
});

describe("add_measurements_to_group", () => {
  it("fails loudly on an index with no measurement, before any membership post", async () => {
    const { calls } = stubFetch([{ body: { "1": { uuid: "aaa" } } }]);
    await expect(
      invoke("add_measurements_to_group", new RewClient(), { group: "g1", measurements: ["9"] }),
    ).rejects.toThrow(/no measurement at index 9/);
    expect(wire(calls).filter(([method]) => method === "POST")).toEqual([]);
  });

  it("posts one MeasurementSummary-shaped { uuid } per measurement", async () => {
    const { calls } = stubFetch([{}, {}]);
    const result = await invoke("add_measurements_to_group", new RewClient(), {
      group: "g1",
      measurements: ["aaa", "bbb"],
    });
    expect(wire(calls)).toEqual([
      ["POST", "/groups/g1/measurements", { uuid: "aaa" }],
      ["POST", "/groups/g1/measurements", { uuid: "bbb" }],
    ]);
    expect(result).toEqual({ addedCount: 2, added: ["aaa", "bbb"] });
  });
});

describe("get_group_measurements", () => {
  it("normalises the members list to measurement summaries", async () => {
    stubFetch([{ body: { "1": { uuid: "aaa", title: "Left" } } }]);
    const result = await invoke("get_group_measurements", new RewClient(), { group: "g1" });
    expect(result).toEqual([{ uuid: "aaa", title: "Left" }]);
  });
});
