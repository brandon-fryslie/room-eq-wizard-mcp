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
import { measurementListSchema, unknownSchema } from "./types.js";
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
});

if (!rewIsUp) {
  it("live suite skipped — REW not reachable", () => {
    expect(rewIsUp).toBe(false);
  });
}
