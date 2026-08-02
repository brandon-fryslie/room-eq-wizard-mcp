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

const postBody = (calls: FetchCall[], path: string) =>
  calls.find((c) => c.method === "POST" && new URL(c.url).pathname === path)?.body;

describe("get_diagnostics", () => {
  it("reads last error/warning, logs, and the diagnostic flags", async () => {
    stubFetchByPath({
      "/application/last-error": { body: {} },
      "/application/last-warning": { body: { title: "No filters required" } },
      "/application/errors": { body: [] },
      "/application/warnings": { body: [{ title: "No filters required" }] },
      "/application/inhibit-graph-updates": { body: false },
      "/application/logging": { body: false },
    });
    const result = (await invoke("get_diagnostics", new RewClient())) as Record<string, unknown>;
    expect(result.lastWarning).toEqual({ title: "No filters required" });
    expect(result.inhibitGraphUpdates).toBe(false);
    expect(result.apiLogging).toBe(false);
  });
});

describe("configure_application", () => {
  it("posts the flags as bare booleans", async () => {
    const { calls } = stubFetchByPath({
      "/application/inhibit-graph-updates": { body: true },
      "/application/logging": { body: true },
      "/application/last-error": { body: {} },
      "/application/last-warning": { body: {} },
      "/application/errors": { body: [] },
      "/application/warnings": { body: [] },
    });
    await invoke("configure_application", new RewClient(), {
      inhibitGraphUpdates: true,
      apiLogging: true,
    });
    expect(postBody(calls, "/application/inhibit-graph-updates")).toBe(true);
    expect(postBody(calls, "/application/logging")).toBe(true);
  });

  it("rejects a no-op configure", async () => {
    const { calls } = stubFetch([{}]);
    await expect(invoke("configure_application", new RewClient(), {})).rejects.toThrow(
      /inhibitGraphUpdates and\/or apiLogging/,
    );
    expect(calls).toHaveLength(0);
  });
});

describe("clear_command_in_progress", () => {
  it("posts the clear command", async () => {
    const { calls } = stubFetch([{ body: "ok" }]);
    await invoke("clear_command_in_progress", new RewClient());
    expect(postBody(calls, "/application/command")).toEqual({ command: "Clear command in progress" });
  });
});

describe("shutdown_rew", () => {
  it("refuses to shut down without confirm=true, before any wire call", async () => {
    const { calls } = stubFetch([{}]);
    await expect(invoke("shutdown_rew", new RewClient(), { confirm: false })).rejects.toThrow(
      /requires confirm=true/,
    );
    expect(calls).toHaveLength(0);
  });

  it("posts the Shutdown command when confirmed", async () => {
    const { calls } = stubFetch([{}]);
    const result = await invoke("shutdown_rew", new RewClient(), { confirm: true });
    expect(postBody(calls, "/application/command")).toEqual({ command: "Shutdown" });
    expect(result).toEqual({ shuttingDown: true });
  });
});
