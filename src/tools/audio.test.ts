import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { RewClient } from "../rew/client.js";
import { stubFetch, type FetchCall } from "../rew/fetch-stub.js";
import { allTools } from "./index.js";

// [LAW:behavior-not-structure] assert the wire contract and observable output.
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

describe("get_audio_config", () => {
  it("reads the driver-agnostic config plus the Java device block", async () => {
    stubFetch([
      { body: { driver: "Java" } },
      { body: { value: 48000, unit: "Hz" } }, // samplerate
      { body: { calDataAllInputs: { calFilePath: "/mic.txt" } } }, // input-cal
      { body: { calData: { calFilePath: "" } } }, // output-cal
      { body: { device: "Scarlett" } }, // input-device
      { body: { input: "Input 1" } },
      { body: { channel: 1 } },
      { body: 2 }, // num-input-channels
      { body: { device: "Scarlett" } }, // output-device
      { body: { output: "Output 1" } },
    ]);
    const result = (await invoke("get_audio_config", new RewClient())) as Record<string, unknown>;
    expect(result.driver).toBe("Java");
    expect(result.inputDevice).toEqual({ device: "Scarlett" });
    expect(result.numInputChannels).toBe(2);
    expect(result.inputCal).toEqual({ calDataAllInputs: { calFilePath: "/mic.txt" } });
  });

  it("skips the Java device block for a non-Java driver and says why", async () => {
    const { calls } = stubFetch([
      { body: { driver: "ASIO" } },
      { body: { value: 44100, unit: "Hz" } },
      { body: {} }, // input-cal
      { body: {} }, // output-cal
    ]);
    const result = (await invoke("get_audio_config", new RewClient())) as Record<string, unknown>;
    expect(result.driver).toBe("ASIO");
    expect(result).not.toHaveProperty("inputDevice");
    expect(result.deviceSelection).toMatch(/Java driver only/);
    // No /audio/java/* endpoint was touched.
    expect(pathsOf(calls).some((p) => p.startsWith("/audio/java/"))).toBe(false);
  });
});

describe("configure_audio", () => {
  it("posts each provided setting to its own endpoint with REW's body shape", async () => {
    const { calls } = stubFetch([{ body: {} }]); // posts + re-read all repeat {}
    await invoke("configure_audio", new RewClient(), {
      driver: "Java",
      sampleRateHz: 48000,
      inputChannel: 1,
      input: "Input 1",
    });
    expect(postBody(calls, "/audio/driver")).toEqual({ driver: "Java" });
    expect(postBody(calls, "/audio/samplerate")).toEqual({ value: 48000, unit: "Hz" });
    expect(postBody(calls, "/audio/java/input-channel")).toEqual({ channel: 1 });
    expect(postBody(calls, "/audio/java/input")).toEqual({ input: "Input 1" });
  });

  it("rejects a no-op configure before any wire call", async () => {
    const { calls } = stubFetch([{}]);
    await expect(invoke("configure_audio", new RewClient(), {})).rejects.toThrow(
      /at least one audio setting/,
    );
    expect(calls).toHaveLength(0);
  });
});

describe("set_input_calibration", () => {
  it("merges the cal file path into the existing config and PUTs it", async () => {
    const { calls } = stubFetch([
      { body: { currentInputSelection: "Default", calDataAllInputs: { dBFSAt94dBSPL: -22.9 } } },
      {}, // PUT
      { body: { calDataAllInputs: { calFilePath: "/mic.txt" } } }, // re-read
    ]);
    await invoke("set_input_calibration", new RewClient(), { calFilePath: "/mic.txt" });
    const put = calls.find((c) => c.method === "PUT");
    expect(new URL(put!.url).pathname).toBe("/audio/input-cal");
    // Existing selection preserved, existing cal field kept, path merged in.
    expect(put!.body).toEqual({
      currentInputSelection: "Default",
      calDataAllInputs: { dBFSAt94dBSPL: -22.9, calFilePath: "/mic.txt" },
    });
  });

  it("clears the calibration when given an empty path", async () => {
    const { calls } = stubFetch([{ body: { calDataAllInputs: { calFilePath: "/old.txt" } } }, {}, { body: {} }]);
    await invoke("set_input_calibration", new RewClient(), { calFilePath: "" });
    const put = calls.find((c) => c.method === "PUT");
    expect((put!.body as { calDataAllInputs: { calFilePath: string } }).calDataAllInputs.calFilePath).toBe("");
  });
});

describe("input_levels", () => {
  it("starts monitoring then returns the last levels", async () => {
    const { calls } = stubFetch([{}, { body: { unit: "dBFS", rms: [-40], peak: [-30] } }]);
    const result = await invoke("input_levels", new RewClient(), { action: "start" });
    expect(postBody(calls, "/input-levels/command")).toEqual({ command: "Start" });
    expect(pathsOf(calls)).toContain("/input-levels/last-levels");
    expect(result).toEqual({ unit: "dBFS", rms: [-40], peak: [-30] });
  });

  it("stops monitoring", async () => {
    const { calls } = stubFetch([{}, { body: {} }]);
    await invoke("input_levels", new RewClient(), { action: "stop" });
    expect(postBody(calls, "/input-levels/command")).toEqual({ command: "Stop" });
  });

  it("reads levels without posting any command", async () => {
    const { calls } = stubFetch([{ body: { unit: "dBFS", rms: [-42], peak: [-35] } }]);
    const result = await invoke("input_levels", new RewClient(), { action: "read" });
    expect(calls.every((c) => c.method === "GET")).toBe(true);
    expect(pathsOf(calls)).toEqual(["/input-levels/last-levels"]);
    expect(result).toEqual({ unit: "dBFS", rms: [-42], peak: [-35] });
  });
});
