import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { RewClient } from "../rew/client.js";
import { stubFetch, type FetchCall } from "../rew/fetch-stub.js";
import { allTools } from "./index.js";

// [LAW:behavior-not-structure] assert the wire contract — which endpoint receives
// which body — and the observable output. Args cross the tool's own Zod shape first.
async function invoke(name: string, client: RewClient, args: Record<string, unknown> = {}) {
  const tool = allTools.find((t) => t.name === name);
  if (tool === undefined) throw new Error(`no tool named ${name}`);
  return tool.handler(client, z.object(tool.inputSchema).parse(args));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const pathsOf = (calls: FetchCall[]) => calls.map((c) => new URL(c.url).pathname);
const bodyAt = (calls: FetchCall[], path: string) =>
  calls.find((c) => new URL(c.url).pathname === path)?.body;

describe("run_rew_command", () => {
  it.each([
    ["application", "/application/command"],
    ["measurements", "/measurements/command"],
    ["measure", "/measure/command"],
    ["generator", "/generator/command"],
  ])("routes area=%s to %s and enables blocking first", async (area, path) => {
    const { calls } = stubFetch([{}, { body: "ok" }]); // blocking, command
    const result = await invoke("run_rew_command", new RewClient(), { area, command: "Cmd" });
    expect(pathsOf(calls)).toContain("/application/blocking");
    expect(bodyAt(calls, path)).toEqual({ command: "Cmd" });
    expect(result).toBe("ok");
  });

  it("routes area=measurement to the measurement's command endpoint", async () => {
    const { calls } = stubFetch([{}, {}]);
    await invoke("run_rew_command", new RewClient(), {
      area: "measurement",
      measurement: "uuid-1",
      command: "Estimate IR delay",
    });
    expect(pathsOf(calls)).toContain("/measurements/uuid-1/command");
  });

  it("routes area=eq to the measurement's EQ command endpoint", async () => {
    const { calls } = stubFetch([{}, {}]);
    await invoke("run_rew_command", new RewClient(), {
      area: "eq",
      measurement: "3",
      command: "Match target",
    });
    expect(pathsOf(calls)).toContain("/measurements/3/eq/command");
  });

  it("requires a measurement for id-based areas, before any wire call", async () => {
    const { calls } = stubFetch([{}]);
    await expect(
      invoke("run_rew_command", new RewClient(), { area: "eq", command: "Match target" }),
    ).rejects.toThrow(/area 'eq' requires a 'measurement'/);
    expect(calls).toHaveLength(0);
  });

  it("treats a blank measurement as absent for id-based areas", async () => {
    const { calls } = stubFetch([{}]);
    await expect(
      invoke("run_rew_command", new RewClient(), {
        area: "eq",
        command: "Match target",
        measurement: "   ",
      }),
    ).rejects.toThrow(/area 'eq' requires a 'measurement'/);
    expect(calls).toHaveLength(0);
  });

  it("rejects a measurement for non-id areas, before any wire call", async () => {
    const { calls } = stubFetch([{}]);
    await expect(
      invoke("run_rew_command", new RewClient(), {
        area: "application",
        command: "Shutdown",
        measurement: "1",
      }),
    ).rejects.toThrow(/area 'application' does not take a 'measurement'/);
    expect(calls).toHaveLength(0);
  });

  it("passes object (named) parameters through under the parameters key", async () => {
    const { calls } = stubFetch([{}, {}]);
    await invoke("run_rew_command", new RewClient(), {
      area: "measurement",
      measurement: "m1",
      command: "Smooth",
      parameters: { smoothing: "1/3" },
    });
    expect(bodyAt(calls, "/measurements/m1/command")).toEqual({
      command: "Smooth",
      parameters: { smoothing: "1/3" },
    });
  });

  it("passes array (positional) parameters through as an array, not a keyed object", async () => {
    const { calls } = stubFetch([{}, {}]);
    await invoke("run_rew_command", new RewClient(), {
      area: "measurements",
      command: "Dirac",
      parameters: ["48000", "131072", "65536"],
    });
    expect(bodyAt(calls, "/measurements/command")).toEqual({
      command: "Dirac",
      parameters: ["48000", "131072", "65536"],
    });
  });

  it("omits the parameters key entirely when none are given", async () => {
    const { calls } = stubFetch([{}, {}]);
    await invoke("run_rew_command", new RewClient(), {
      area: "measurements",
      command: "Sort alphabetically",
    });
    const body = bodyAt(calls, "/measurements/command");
    expect(body).toEqual({ command: "Sort alphabetically" });
    expect(body).not.toHaveProperty("parameters");
  });

  it("falls back to a completion string when REW returns no body", async () => {
    stubFetch([{}, {}]); // blocking, then empty command response
    const result = await invoke("run_rew_command", new RewClient(), {
      area: "application",
      command: "Fit main graph axes to data",
    });
    expect(result).toBe("Command 'Fit main graph axes to data' completed");
  });
});
