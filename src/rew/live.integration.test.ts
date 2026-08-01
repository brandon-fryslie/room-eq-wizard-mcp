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
});

if (!rewIsUp) {
  it("live suite skipped — REW not reachable", () => {
    expect(rewIsUp).toBe(false);
  });
}
