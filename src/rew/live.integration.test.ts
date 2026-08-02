// Live integration checks against a running REW instance. These self-skip when
// REW is not listening, so the suite is safe in CI and meaningful on a machine
// where REW is up with -api. [LAW:verifiable-goals] this file is the gate that
// turns "mock-verified" into "REW-verified".

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { RewClient } from "./client.js";
import { groupListSchema, groupMeasurementsSchema, measurementListSchema, unknownSchema } from "./types.js";
import { alignmentStateEndpoints } from "../tools/alignment.js";
import { RTA_CONTROL_COMMANDS, RTA_SAVE_COMMANDS } from "../tools/rta.js";
import { allTools } from "../tools/index.js";

const baseUrl = process.env.REW_API_URL ?? "http://127.0.0.1:4735";
const rewIsUp = await fetch(`${baseUrl}/application/commands`, {
  signal: AbortSignal.timeout(1500),
}).then(
  (res) => res.ok,
  () => false,
);

describe.skipIf(!rewIsUp)("live REW", () => {
  const client = new RewClient({ baseUrl });

  it("lists application commands", async () => {
    const commands = await client.get("/application/commands", unknownSchema);
    expect(commands).toBeTruthy();
  });

  it("parses the real measurement list shape", async () => {
    const raw = await client.get("/measurements", measurementListSchema);
    expect(typeof raw).toBe("object");
  });

  it("reports generator status", async () => {
    const status = await client.get("/generator/status", unknownSchema);
    expect(status).toBeTruthy();
  });

  // The alignment command names shipped in src/tools/alignment.ts were pinned
  // from reference implementations, never a live REW. This is the check that
  // reality agrees; if it fails, fix the pinned strings, not this test.
  it("advertises the pinned alignment tool commands", async () => {
    const commands = await client.get("/alignment-tool/commands", unknownSchema);
    const asText = JSON.stringify(commands);
    expect(asText).toContain("Align phase");
    expect(asText).toContain("Aligned sum");
  });

  it("answers every alignment state endpoint", async () => {
    for (const endpoint of alignmentStateEndpoints) {
      await expect(
        client.get(`/alignment-tool/${endpoint}`, unknownSchema),
        endpoint,
      ).resolves.toBeDefined();
    }
    const modes = await client.get("/alignment-tool/modes", unknownSchema);
    expect(JSON.stringify(modes)).toContain("Phase");
  });

  // room-import-hwk acceptance: import a text FR file and see it appear in
  // /measurements. Runs the real tool end to end, then deletes what it created.
  it("imports a text frequency response file into /measurements", async () => {
    const tool = allTools.find((t) => t.name === "import_frequency_response");
    if (tool === undefined) throw new Error("import_frequency_response tool missing");
    const dir = await mkdtemp(join(tmpdir(), "rew-import-live-"));
    const filePath = join(dir, "live-import-fr.txt");
    // 1/3-octave flat-ish response, "freq SPL phase" per line — the format
    // REW's frequency response text import documents.
    const points = Array.from({ length: 31 }, (_, i) => {
      const freq = 20 * 2 ** (i / 3);
      return `${freq.toFixed(2)} ${(75 + Math.sin(i)).toFixed(2)} 0.0`;
    });
    await writeFile(filePath, points.join("\n"));
    try {
      const result = (await tool.handler(
        client,
        z.object(tool.inputSchema).parse({ filePath }),
      )) as { importedCount: number; imported: Array<{ uuid: string }> };
      expect(result.importedCount).toBeGreaterThanOrEqual(1);
      const list = await client.get("/measurements", measurementListSchema);
      expect(JSON.stringify(list)).toContain(result.imported[0].uuid);
      for (const m of result.imported) {
        await client.delete(`/measurements/${m.uuid}`);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // room-groups-wwa acceptance: full group lifecycle against a real REW. This
  // is also what pins the two shapes the API doc leaves open — whether GET
  // /groups and GET /groups/:uuid/measurements answer arrays or index-keyed
  // records — since groupListSchema/groupMeasurementsSchema accept both.
  it("creates, fills, renames, and deletes a measurement group", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rew-groups-live-"));
    const filePath = join(dir, "live-group-fr.txt");
    const points = Array.from({ length: 31 }, (_, i) => `${(20 * 2 ** (i / 3)).toFixed(2)} 75.0 0.0`);
    await writeFile(filePath, points.join("\n"));
    const groupName = `live-suite-${Date.now()}`;
    let groupUuid: string | undefined;
    let measurementUuid: string | undefined;
    try {
      const importTool = allTools.find((t) => t.name === "import_frequency_response");
      if (importTool === undefined) throw new Error("import_frequency_response tool missing");
      const imported = (await importTool.handler(
        client,
        z.object(importTool.inputSchema).parse({ filePath }),
      )) as { imported: Array<{ uuid: string }> };
      measurementUuid = imported.imported[0].uuid;

      const created = (await client.post("/groups", { name: groupName })) as { uuid: string };
      groupUuid = created.uuid;
      expect(groupUuid).toBeTruthy();

      const groups = await client.get("/groups", groupListSchema);
      expect(groups.map((g) => g.uuid)).toContain(groupUuid);

      await client.post(`/groups/${groupUuid}/measurements`, { uuid: measurementUuid });
      const members = await client.get(`/groups/${groupUuid}/measurements`, groupMeasurementsSchema);
      expect(members.map((m) => m.uuid)).toContain(measurementUuid);

      await client.put(`/groups/${groupUuid}`, { notes: "written by the live suite" });
      const renamed = await client.get("/groups", groupListSchema);
      expect(renamed.find((g) => g.uuid === groupUuid)?.notes).toBe("written by the live suite");

      await client.delete(`/groups/${groupUuid}`);
      groupUuid = undefined;
      const after = await client.get("/groups", groupListSchema);
      expect(after.map((g) => g.uuid)).not.toContain(created.uuid);
    } finally {
      if (groupUuid !== undefined) await client.delete(`/groups/${groupUuid}`);
      if (measurementUuid !== undefined) await client.delete(`/measurements/${measurementUuid}`);
      await rm(dir, { recursive: true, force: true });
    }
  });

  // room-api-coverage-2p5.1: the RTA command names in src/tools/rta.ts were pinned
  // against this live /rta/commands list (Start/Stop/Reset averaging for control_rta,
  // Save current/peak/both for save_rta_capture). This is the check that reality
  // still agrees; if it fails, fix the pinned strings, not this test.
  it("advertises the pinned RTA commands and answers its state endpoints", async () => {
    const commands = await client.get("/rta/commands", unknownSchema);
    const asText = JSON.stringify(commands);
    // Derived from the tool's own constants — the single source of the strings, so
    // adding a command there automatically extends this reality check.
    for (const command of [...Object.values(RTA_CONTROL_COMMANDS), ...Object.values(RTA_SAVE_COMMANDS)]) {
      expect(asText, command).toContain(command);
    }
    await expect(client.get("/rta/status", unknownSchema)).resolves.toBeDefined();
    await expect(client.get("/rta/configuration", unknownSchema)).resolves.toBeDefined();
  });

  // configure_rta posts a partial config; confirm REW merges it (leaves the other
  // fields intact) rather than replacing the whole object. Round-trip whichever
  // scalar field is actually present to its own value — so the suite mutates
  // nothing net and assumes no particular field exists — then assert the entire
  // config is unchanged: a merge preserves every untouched field, a replace would
  // drop them.
  it("applies a partial RTA configuration without disturbing other fields", async () => {
    const before = (await client.get("/rta/configuration", unknownSchema)) as Record<string, unknown>;
    // Guard before Object.entries: a null/non-object response should fail as a
    // clear assertion, not a TypeError. (typeof null === "object", so check truthy too.)
    expect(before).toBeTruthy();
    expect(typeof before).toBe("object");
    const scalar = Object.entries(before).find(
      ([, v]) => typeof v === "string" || typeof v === "number" || typeof v === "boolean",
    );
    if (scalar === undefined) throw new Error("no scalar RTA config field to round-trip");
    const [field, value] = scalar;
    const configureRta = allTools.find((t) => t.name === "configure_rta");
    if (configureRta === undefined) throw new Error("configure_rta tool missing");
    const after = (await configureRta.handler(
      client,
      z.object(configureRta.inputSchema).parse({ settings: { [field]: value } }),
    )) as Record<string, unknown>;
    expect(after).toEqual(before);
  });

  // room-api-coverage-2p5.2: run_rew_command end to end against a real REW. "Dirac"
  // on the measurements area generates a synthetic impulse measurement — a
  // state-independent command that exercises the array (positional) parameters path
  // and proves the generic escape hatch reaches REW and creates real output. The
  // created measurement is deleted afterwards so the suite leaves nothing behind.
  it("runs a measurements command (Dirac) through run_rew_command and cleans up", async () => {
    const runRewCommand = allTools.find((t) => t.name === "run_rew_command");
    if (runRewCommand === undefined) throw new Error("run_rew_command tool missing");
    const before = new Set(
      Object.values(await client.get("/measurements", measurementListSchema)).map((m) => m.uuid),
    );
    let createdUuid: string | undefined;
    try {
      await runRewCommand.handler(
        client,
        z.object(runRewCommand.inputSchema).parse({
          area: "measurements",
          command: "Dirac",
          parameters: ["48000", "131072", "65536"],
        }),
      );
      const after = Object.values(await client.get("/measurements", measurementListSchema));
      const created = after.find((m) => !before.has(m.uuid));
      expect(created).toBeDefined();
      createdUuid = created?.uuid;
    } finally {
      if (createdUuid !== undefined) await client.delete(`/measurements/${createdUuid}`);
    }
  });

  // room-api-coverage-2p5.3: audio preflight against a real REW.
  it("reads the audio config and reports the mic calibration state", async () => {
    const getAudioConfig = allTools.find((t) => t.name === "get_audio_config");
    if (getAudioConfig === undefined) throw new Error("get_audio_config tool missing");
    const config = (await getAudioConfig.handler(client, {})) as Record<string, unknown>;
    expect(config.driver).toBeTruthy();
    // inputCal is always present; its calFilePath (possibly empty) is the cal signal.
    expect(config.inputCal).toBeDefined();
  });

  it("runs the input-levels monitor start → read → stop cycle", async () => {
    const inputLevels = allTools.find((t) => t.name === "input_levels");
    if (inputLevels === undefined) throw new Error("input_levels tool missing");
    const parse = (a: Record<string, unknown>) => z.object(inputLevels.inputSchema).parse(a);
    try {
      await expect(inputLevels.handler(client, parse({ action: "start" }))).resolves.toBeDefined();
      await expect(inputLevels.handler(client, parse({ action: "read" }))).resolves.toBeDefined();
    } finally {
      // Best-effort cleanup: a stop failure must not supersede and mask a real
      // start/read assertion error from the try block.
      await inputLevels.handler(client, parse({ action: "stop" })).catch(() => {});
    }
  });
});

if (!rewIsUp) {
  it("live suite skipped — REW not reachable", () => {
    expect(rewIsUp).toBe(false);
  });
}
