import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { RewClient } from "../rew/client.js";
import { stubFetchWith, type FetchCall } from "../rew/fetch-stub.js";
import { allTools } from "./index.js";

async function invoke(name: string, client: RewClient, args: Record<string, unknown> = {}) {
  const tool = allTools.find((t) => t.name === name);
  if (tool === undefined) throw new Error(`no tool named ${name}`);
  return tool.handler(client, z.object(tool.inputSchema).parse(args));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// A log-spaced response with one narrow dip — enough for the detector to have
// something to find, and for the wire assertions below to be about the request.
function responseBody(smoothing: string) {
  const startFreq = 20;
  const ppo = 96;
  const n = 480;
  const mags = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    const hz = startFreq * Math.pow(2, i / ppo);
    mags.writeFloatBE(75 - 8 * Math.exp(-(((Math.log2(hz / 120)) / 0.03) ** 2)), i * 4);
  }
  return { startFreq, ppo, magnitude: mags.toString("base64"), smoothing, unit: "SPL" };
}

const smoothingQuery = (calls: FetchCall[]) =>
  new URL(calls.find((c) => c.url.includes("frequency-response"))!.url).searchParams.get("smoothing");

describe("analyze_response smoothing", () => {
  it("asks REW for the smoothing the caller chose", async () => {
    const { calls } = stubFetchWith(() => ({ body: responseBody("1/3") }));
    await invoke("analyze_response", new RewClient(), { measurement: "m1", smoothing: "1/3" });
    expect(smoothingQuery(calls)).toBe("1/3");
  });

  it("defaults to 1/12 rather than whatever the measurement is displaying", async () => {
    const { calls } = stubFetchWith(() => ({ body: responseBody("1/12") }));
    await invoke("analyze_response", new RewClient(), { measurement: "m1" });
    expect(smoothingQuery(calls)).toBe("1/12");
  });

  it("reports the smoothing actually analysed, which REW may substitute", async () => {
    // Asking for None on this endpoint really does come back 1/48 — REW has no
    // unsmoothed log-spaced form. Reporting REW's answer keeps that visible.
    const { calls } = stubFetchWith(() => ({ body: responseBody("1/48") }));
    const r = (await invoke("analyze_response", new RewClient(), {
      measurement: "m1",
      smoothing: "None",
    })) as { smoothing: string };
    expect(smoothingQuery(calls)).toBe("None");
    expect(r.smoothing).toBe("1/48");
  });

  it("rejects a smoothing REW would answer 400 for", async () => {
    stubFetchWith(() => ({ body: responseBody("1/12") }));
    await expect(
      invoke("analyze_response", new RewClient(), { measurement: "m1", smoothing: "Variable" }),
    ).rejects.toThrow();
  });
});
