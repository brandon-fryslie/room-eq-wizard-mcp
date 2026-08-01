// Live integration checks against a running REW instance. These self-skip when
// REW is not listening, so the suite is safe in CI and meaningful on a machine
// where REW is up with -api. [LAW:verifiable-goals] this file is the gate that
// turns "mock-verified" into "REW-verified".

import { describe, expect, it } from "vitest";
import { RewClient } from "./client.js";
import { measurementListSchema, unknownSchema } from "./types.js";

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
});

if (!rewIsUp) {
  it("live suite skipped — REW not reachable", () => {
    expect(rewIsUp).toBe(false);
  });
}
