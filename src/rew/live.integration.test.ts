// Live integration checks against a running REW instance. These self-skip when
// REW is not listening, so the suite is safe in CI and meaningful on a machine
// where REW is up with -api. [LAW:verifiable-goals] this file is the gate that
// turns "mock-verified" into "REW-verified".

import { describe, expect, it } from "vitest";
import { RewClient } from "./client.js";
import { measurementListSchema, unknownSchema } from "./types.js";
import { alignmentStateEndpoints } from "../tools/alignment.js";

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
});

if (!rewIsUp) {
  it("live suite skipped — REW not reachable", () => {
    expect(rewIsUp).toBe(false);
  });
}
