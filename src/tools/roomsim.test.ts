import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { RewClient } from "../rew/client.js";
import { stubFetch, stubFetchByPath, type FetchCall } from "../rew/fetch-stub.js";
import { encodeFloats } from "../rew/codec.js";
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

describe("get_roomsim_config", () => {
  it("reads the room, sources, and options into one object", async () => {
    stubFetchByPath({
      "/roomsim/room-size": { body: { unit: "metres", length: 5, width: 4, height: 2.4 } },
      "/roomsim/room-is-sealed": { body: false },
      "/roomsim/absorptions": { body: { front: 0.1, floor: 0.05 } },
      "/roomsim/sources": { body: { sources: ["Sub1", "Left", "Right"] } },
      "/roomsim/mic-posn-offsets": { body: { unit: "metres", left: 0.3 } },
      "/roomsim/options": { body: { crossoverFrequencyHz: 80 } },
    });
    const result = (await invoke("get_roomsim_config", new RewClient())) as Record<string, unknown>;
    expect(result.roomSize).toEqual({ unit: "metres", length: 5, width: 4, height: 2.4 });
    expect(result.sealed).toBe(false);
    expect(result.sources).toEqual({ sources: ["Sub1", "Left", "Right"] });
  });
});

describe("configure_roomsim", () => {
  it("merges a room dimension into the current size and posts it", async () => {
    const { calls } = stubFetchByPath({
      "/roomsim/room-size": { body: { unit: "metres", length: 5, width: 4, height: 2.4 } },
      "/roomsim/room-is-sealed": { body: false },
      "/roomsim/absorptions": { body: {} },
      "/roomsim/sources": { body: { sources: [] } },
      "/roomsim/mic-posn-offsets": { body: {} },
      "/roomsim/options": { body: {} },
    });
    await invoke("configure_roomsim", new RewClient(), { lengthM: 6 });
    expect(postBody(calls, "/roomsim/room-size")).toEqual({ unit: "metres", length: 6, width: 4, height: 2.4 });
  });

  it("posts the sealed flag and merges absorptions", async () => {
    const { calls } = stubFetchByPath({
      "/roomsim/room-size": { body: { length: 5, width: 4, height: 2.4 } },
      "/roomsim/room-is-sealed": { body: true },
      "/roomsim/absorptions": { body: { front: 0.1, floor: 0.05 } },
      "/roomsim/sources": { body: { sources: [] } },
      "/roomsim/mic-posn-offsets": { body: {} },
      "/roomsim/options": { body: {} },
    });
    await invoke("configure_roomsim", new RewClient(), {
      sealed: true,
      absorptions: { front: 0.2 },
    });
    expect(postBody(calls, "/roomsim/room-is-sealed")).toBe(true);
    // Merged over current: front changed, floor preserved.
    expect(postBody(calls, "/roomsim/absorptions")).toEqual({ front: 0.2, floor: 0.05 });
  });

  it("rejects a no-op configure", async () => {
    const { calls } = stubFetch([{}]);
    await expect(invoke("configure_roomsim", new RewClient(), {})).rejects.toThrow(
      /at least one room-sim setting/,
    );
    expect(calls).toHaveLength(0);
  });
});

describe("set_roomsim_source", () => {
  it("merges a source's position and returns its state", async () => {
    const { calls } = stubFetchByPath({
      "/roomsim/Sub1/position": { body: { unit: "metres", fromRear: 4.7, fromLeft: 0.15, fromFloor: 0.15 } },
      "/roomsim/Sub1/configuration": { body: { enclosureType: "Ported" } },
    });
    const result = (await invoke("set_roomsim_source", new RewClient(), {
      source: "Sub1",
      position: { fromLeft: 1.0 },
    })) as { source: string; position: unknown; configuration: unknown };
    expect(postBody(calls, "/roomsim/Sub1/position")).toEqual({
      unit: "metres",
      fromRear: 4.7,
      fromLeft: 1.0,
      fromFloor: 0.15,
    });
    expect(result.source).toBe("Sub1");
    // The result reflects the re-read of both sub-resources (stateless stub → the
    // stub bodies), proving the handler returns the re-GET, not stale/ad-hoc data.
    expect(result.position).toEqual({ unit: "metres", fromRear: 4.7, fromLeft: 0.15, fromFloor: 0.15 });
    expect(result.configuration).toEqual({ enclosureType: "Ported" });
  });

  it("rejects an empty source name", async () => {
    const { calls } = stubFetch([{}]);
    await expect(
      invoke("set_roomsim_source", new RewClient(), { source: "", position: { fromLeft: 1 } }),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("rejects a source change with nothing to set", async () => {
    const { calls } = stubFetch([{}]);
    await expect(invoke("set_roomsim_source", new RewClient(), { source: "Sub1" })).rejects.toThrow(
      /position and\/or configuration/,
    );
    expect(calls).toHaveLength(0);
  });
});

describe("get_roomsim_response", () => {
  it("reads the summed response with the mic position and summarises it", async () => {
    const { calls } = stubFetch([{ body: { startFreq: 20, ppo: 12, magnitude: encodeFloats([70, 72, 71, 69]) } }]);
    const result = (await invoke("get_roomsim_response", new RewClient(), { micPosition: "To left" })) as {
      source: string;
      points: unknown[];
    };
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/roomsim/frequency-response");
    expect(url.searchParams.get("micposition")).toBe("To left");
    expect(result.source).toBe("all sources summed");
    expect(result.points.length).toBe(4);
  });

  it("reads a single source's response from its own endpoint", async () => {
    const { calls } = stubFetch([{ body: { startFreq: 20, ppo: 12, magnitude: encodeFloats([70, 72, 71]) } }]);
    await invoke("get_roomsim_response", new RewClient(), { source: "Sub1" });
    expect(new URL(calls[0].url).pathname).toBe("/roomsim/Sub1/frequency-response");
  });
});
