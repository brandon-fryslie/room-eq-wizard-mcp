import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { RewClient } from "../rew/client.js";
import { stubFetch, stubFetchByPath, type FetchCall } from "../rew/fetch-stub.js";
import { allTools } from "./index.js";

async function invoke(name: string, client: RewClient, args: Record<string, unknown> = {}) {
  const tool = allTools.find((t) => t.name === name);
  if (tool === undefined) throw new Error(`no tool named ${name}`);
  return tool.handler(client, z.object(tool.inputSchema).parse(args));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const pathsOf = (calls: FetchCall[]) => calls.map((c) => new URL(c.url).pathname);
const postBody = (calls: FetchCall[], path: string) =>
  calls.find((c) => c.method === "POST" && new URL(c.url).pathname === path)?.body;

describe("read_spl", () => {
  it("routes to the selected meter for config, start, read, and stop", async () => {
    const { calls } = stubFetch([{}, {}, { body: { spl: 75, leq: 74 } }, {}]);
    const result = await invoke("read_spl", new RewClient(), { meterNumber: 3, settleSeconds: 0 });
    expect(pathsOf(calls)).toEqual([
      "/spl-meter/3/configuration",
      "/spl-meter/3/command",
      "/spl-meter/3/levels",
      "/spl-meter/3/command",
    ]);
    expect(result).toMatchObject({ spl: 75 });
  });
});

describe("spl_meter_config", () => {
  it("merges the rolling-Leq fields over current for the chosen meter", async () => {
    const { calls } = stubFetch([
      { body: { showSPL: true, rollingLeqActive: false, rollingLeqMinutes: 1 } }, // current
      {}, // POST
      { body: { showSPL: true, rollingLeqActive: true, rollingLeqMinutes: 15 } }, // re-read
    ]);
    const result = await invoke("spl_meter_config", new RewClient(), {
      meterNumber: 1,
      rollingLeqActive: true,
      rollingLeqMinutes: 15,
    });
    expect(postBody(calls, "/spl-meter/1/configuration")).toEqual({
      showSPL: true,
      rollingLeqActive: true,
      rollingLeqMinutes: 15,
    });
    expect(result).toMatchObject({ rollingLeqMinutes: 15 });
  });

  it("reads the config when only meterNumber is given (no POST)", async () => {
    const { calls } = stubFetch([{ body: { showSPL: true } }]);
    const result = await invoke("spl_meter_config", new RewClient(), { meterNumber: 2 });
    expect(calls.every((c) => c.method === "GET")).toBe(true);
    expect(new URL(calls[0].url).pathname).toBe("/spl-meter/2/configuration");
    expect(result).toEqual({ showSPL: true });
  });
});

describe("read_spl wire contract", () => {
  const levels = (over = {}) => ({
    meterNumber: 1,
    splWeighting: "C",
    filter: "Slow",
    spl: 74.2,
    ...over,
  });

  it("sends REW's real field names, not mode/weighting", async () => {
    // REW merges partial config and answers "Configuration processed" while dropping
    // keys it does not know, so a wrong name here is silent — hence this assertion.
    const { calls } = stubFetchByPath({
      "/spl-meter/1/configuration": { body: {} },
      "/spl-meter/1/command": { body: {} },
      "/spl-meter/1/levels": { body: levels() },
    });
    await invoke("read_spl", new RewClient(), { weighting: "C", filter: "Slow", settleSeconds: 0 });
    const cfg = calls.find(
      (c) => c.method === "POST" && new URL(c.url).pathname === "/spl-meter/1/configuration",
    )?.body as Record<string, unknown>;
    expect(cfg).toEqual({ showSPL: true, splWeighting: "C", filter: "Slow" });
    expect(cfg).not.toHaveProperty("mode");
    expect(cfg).not.toHaveProperty("weighting");
  });

  it("errors when the meter read a different weighting than was asked for", async () => {
    stubFetchByPath({
      "/spl-meter/1/configuration": { body: {} },
      "/spl-meter/1/command": { body: {} },
      "/spl-meter/1/levels": { body: levels({ splWeighting: "A" }) },
    });
    await expect(
      invoke("read_spl", new RewClient(), { weighting: "C", settleSeconds: 0 }),
    ).rejects.toThrow(/Asked for C-weighting but the meter read A/);
  });

  it("reports a level REW could not compute as null, not as a number", async () => {
    // A running meter with no signal sends bare NaN; null keeps "no reading" testable.
    stubFetchByPath({
      "/spl-meter/1/configuration": { body: {} },
      "/spl-meter/1/command": { body: {} },
      "/spl-meter/1/levels": { body: levels({ spl: null, leq: null }) },
    });
    const r = (await invoke("read_spl", new RewClient(), {
      weighting: "C",
      settleSeconds: 0,
    })) as Record<string, unknown>;
    expect(r.spl).toBeNull();
    expect(r.splWeighting).toBe("C");
  });
});
