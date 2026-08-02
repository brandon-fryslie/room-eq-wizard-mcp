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

  // room-api-coverage-2p5.4: get_measure_config reads the session settings. Only the
  // reads are exercised live — the /measure write actions (configure_measurement,
  // set_measurement_protection, measure_impedance) are Pro-gated (401 without a Pro
  // licence), so they are mock-verified, matching run_sweep's untested-live status.
  it("reads the measurement-session config", async () => {
    const getMeasureConfig = allTools.find((t) => t.name === "get_measure_config");
    if (getMeasureConfig === undefined) throw new Error("get_measure_config tool missing");
    const config = (await getMeasureConfig.handler(client, {})) as Record<string, unknown>;
    expect(config.measurementMode).toBeDefined();
    expect(config.protectionOptions).toBeDefined();
  });

  // room-api-coverage-2p5.5: the EQ layer end to end. Unlike /measure, EQ commands
  // and config are NOT Pro-gated, so the whole flow runs live. A Dirac gives us a
  // measurement to EQ; we read its target, run an EQ command that creates a new
  // measurement, and render the filter IR — then delete everything we made.
  it("reads EQ settings and runs an EQ command that creates a measurement", async () => {
    const tool = (name: string) => {
      const t = allTools.find((x) => x.name === name);
      if (t === undefined) throw new Error(`${name} tool missing`);
      return (a: Record<string, unknown>) => t.handler(client, z.object(t.inputSchema).parse(a));
    };
    const uuids = async () =>
      Object.values(await client.get("/measurements", measurementListSchema)).map((m) => m.uuid);
    const before = new Set(await uuids());
    // Track what we create so cleanup deletes from this list without a fresh GET —
    // a re-fetch in the finally would throw and skip every delete if REW went away.
    const created: string[] = [];
    try {
      await client.command("/measurements/command", {
        command: "Dirac",
        parameters: ["48000", "65536", "32768"],
      });
      const dirac = (await uuids()).find((u) => !before.has(u));
      if (dirac === undefined) throw new Error("Dirac created no measurement");
      created.push(dirac);

      // Reads that need no EQ setup.
      await expect(tool("get_target_response")({ measurement: dirac })).resolves.toBeDefined();
      await expect(tool("eq_match_target_settings")({})).resolves.toBeDefined();
      await expect(tool("house_curve")({ action: "get" })).resolves.toBeDefined();

      // Set the equaliser so filters exist, then a command that creates a measurement.
      await client.post(`/measurements/${dirac}/equaliser`, { manufacturer: "Generic", model: "Generic" });
      const result = (await tool("run_eq_command")({
        measurement: dirac,
        command: "Generate filters measurement",
      })) as { created: Array<{ uuid: string }> };
      expect(result.created.length).toBeGreaterThanOrEqual(1);
      for (const m of result.created) created.push(m.uuid);

      // Give the filter bank an effective filter (REW's field is `gaindB`) so the
      // impulse response has something to render — a flat Dirac otherwise has none.
      await client.put(`/measurements/${dirac}/filters`, {
        index: 1,
        type: "PK",
        frequency: 60,
        gaindB: -3,
        q: 2,
        enabled: true,
      });
      // The gaindB fix: the set gain must survive a read back (a `gain` field would not).
      const filters = (await tool("get_eq_filters")({ measurement: dirac })) as Array<{
        index?: number;
        gaindB?: number;
      }>;
      expect(filters.find((f) => f.index === 1)?.gaindB).toBeCloseTo(-3, 3);

      const ir = (await tool("get_filters_impulse_response")({
        measurement: dirac,
        sampleRate: 48000,
        length: 8192,
      })) as { numSamples: number };
      expect(ir.numSamples).toBe(8192);
    } finally {
      // Delete from the tracked list — no fresh GET, so cleanup runs even if REW's
      // measurement list is now unreachable. Each delete is best-effort.
      for (const u of created) await client.delete(`/measurements/${u}`).catch(() => {});
    }
  });

  // room-api-coverage-2p5.6: the IR-derived reads and processes (not Pro-gated). A
  // Dirac has an impulse response, so it exercises every read; generate_phase_version
  // creates a measurement. Everything created is deleted afterwards.
  it("reads IR data and runs an IR process on a measurement", async () => {
    const tool = (name: string) => {
      const t = allTools.find((x) => x.name === name);
      if (t === undefined) throw new Error(`${name} tool missing`);
      return (a: Record<string, unknown>) => t.handler(client, z.object(t.inputSchema).parse(a));
    };
    const before = new Set(
      Object.values(await client.get("/measurements", measurementListSchema)).map((m) => m.uuid),
    );
    const created: string[] = [];
    try {
      await client.command("/measurements/command", {
        command: "Dirac",
        parameters: ["48000", "65536", "32768"],
      });
      const dirac = Object.values(await client.get("/measurements", measurementListSchema))
        .map((m) => m.uuid)
        .find((u) => !before.has(u));
      if (dirac === undefined) throw new Error("Dirac created no measurement");
      created.push(dirac);

      const ir = (await tool("get_impulse_response")({ measurement: dirac })) as { numSamples: number };
      expect(ir.numSamples).toBeGreaterThan(0);
      await expect(tool("get_group_delay")({ measurement: dirac })).resolves.toBeDefined();
      await expect(tool("ir_windows")({ measurement: dirac })).resolves.toBeDefined();

      const phase = (await tool("generate_phase_version")({ measurement: dirac, kind: "minimum" })) as {
        measurement: { uuid: string };
      };
      created.push(phase.measurement.uuid);
      expect(phase.measurement.uuid).toBeTruthy();
    } finally {
      for (const u of created) await client.delete(`/measurements/${u}`).catch(() => {});
    }
  });

  // room-api-coverage-2p5.7: waterfall + spectrogram reduce to findings. This also
  // confirms the spectrogram result uses the same Frequencies/Times/slices surface
  // shape the waterfall does (the tool parses both the same way).
  it("generates a waterfall and spectrogram and returns reduced decay findings", async () => {
    const tool = (name: string) => {
      const t = allTools.find((x) => x.name === name);
      if (t === undefined) throw new Error(`${name} tool missing`);
      return (a: Record<string, unknown>) => t.handler(client, z.object(t.inputSchema).parse(a));
    };
    const before = new Set(
      Object.values(await client.get("/measurements", measurementListSchema)).map((m) => m.uuid),
    );
    let dirac: string | undefined;
    try {
      await client.command("/measurements/command", {
        command: "Dirac",
        parameters: ["48000", "65536", "32768"],
      });
      dirac = Object.values(await client.get("/measurements", measurementListSchema))
        .map((m) => m.uuid)
        .find((u) => !before.has(u));
      if (dirac === undefined) throw new Error("Dirac created no measurement");

      const wf = (await tool("generate_waterfall")({ measurement: dirac, slices: 20 })) as {
        kind: string;
        bands: unknown[];
        sliceCount: number;
      };
      expect(wf.kind).toBe("waterfall");
      expect(wf.bands.length).toBeGreaterThan(0);
      expect(wf.sliceCount).toBe(20);

      const sg = (await tool("generate_spectrogram")({ measurement: dirac, slices: 20 })) as {
        kind: string;
      };
      expect(sg.kind).toBe("spectrogram");
    } finally {
      if (dirac !== undefined) await client.delete(`/measurements/${dirac}`).catch(() => {});
    }
  });
});

if (!rewIsUp) {
  it("live suite skipped — REW not reachable", () => {
    expect(rewIsUp).toBe(false);
  });
}
