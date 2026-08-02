// One escape hatch over REW's whole command protocol. Every REW command endpoint
// accepts the same POST body — { command, parameters } — where parameters is an
// object of named settings or an array of positional values (rew_api.md is explicit:
// "Load"/"Dirac" take arrays, "Smooth"/"Generate waterfall"/"Match target" take
// objects). This tool closes the coverage gaps the dedicated tools left — application,
// generator, measure, and per-measurement EQ — and is the universal fallback for any
// command not yet wrapped, so a future API gap is survivable in the meantime.
//
// The alignment tool and RTA are deliberately absent from the area enum: their
// command bodies do NOT follow the standard shape. The alignment tool takes its
// parameters at the top level ({ command, frequency }) rather than nested, and RTA
// control must stay non-blocking (a blocking "Start" would wait forever). Those keep
// their dedicated tools — run_alignment_command, and run_rta_command / control_rta.

import { z } from "zod";
import { defineTool, measurementIdInput } from "./registry.js";

// area → command endpoint. The two id-based areas carry a {m} placeholder for the
// measurement. [LAW:one-source-of-truth] the command-area vocabulary lives once here.
const COMMAND_AREAS = {
  application: { path: "/application/command", needsMeasurement: false },
  measurements: { path: "/measurements/command", needsMeasurement: false },
  measure: { path: "/measure/command", needsMeasurement: false },
  generator: { path: "/generator/command", needsMeasurement: false },
  measurement: { path: "/measurements/{m}/command", needsMeasurement: true },
  eq: { path: "/measurements/{m}/eq/command", needsMeasurement: true },
} as const;

export const commandTools = [
  defineTool({
    name: "run_rew_command",
    description:
      "Run any REW command on a command endpoint — the universal escape hatch for capabilities without a dedicated tool. Discover command names with list_api_commands (per area) or get_measurement_commands (per measurement). 'area' selects the endpoint; 'measurement' is required for the 'measurement' and 'eq' areas and rejected for the others. Parameters follow REW's docs: an object for named params (e.g. { smoothing: '1/3' }) or an array for positional params (e.g. ['/path/file.mdat']). Blocks until the command completes and returns REW's result. The alignment tool and RTA have their own tools (run_alignment_command, run_rta_command / control_rta) because their command bodies differ.",
    inputSchema: {
      area: z
        .enum(["application", "measurements", "measure", "generator", "measurement", "eq"])
        .describe(
          "Command endpoint: application, measurements (list-level, e.g. Load/Dirac), measure, generator, measurement (one measurement), or eq (one measurement's EQ)",
        ),
      command: z
        .string()
        .describe("REW command name, e.g. 'Dirac', 'Match target', 'Fit main graph axes to data'"),
      parameters: z
        // Array first: an array is also an object, so z.record would match it and
        // coerce positional params into a keyed object. Array-first keeps arrays arrays.
        .union([z.array(z.unknown()), z.record(z.string(), z.unknown())])
        .optional()
        .describe(
          "Command parameters as REW documents them: an object of named params, or an array of positional params. Omit for commands that take none.",
        ),
      measurement: measurementIdInput
        .optional()
        .describe(
          "Target measurement (UUID or 1-based index) — required for the 'measurement' and 'eq' areas, omit for the rest",
        ),
    },
    handler: async (client, args) => {
      const spec = COMMAND_AREAS[args.area];
      // [LAW:no-silent-failure] a mismatched measurement/area would otherwise hit the
      // wrong URL (or splice "undefined" into the path) and fail obscurely. This one
      // check covers both directions: needed-but-absent, and given-but-not-applicable.
      if (spec.needsMeasurement === (args.measurement === undefined)) {
        throw new Error(
          spec.needsMeasurement
            ? `area '${args.area}' requires a 'measurement' (UUID or 1-based index)`
            : `area '${args.area}' does not take a 'measurement'`,
        );
      }
      // The guard guarantees a measurement is present whenever the path carries {m};
      // for the other areas {m} is absent so the replacement is a no-op.
      const endpoint = spec.path.replace("{m}", encodeURIComponent(args.measurement ?? ""));
      const body =
        args.parameters !== undefined
          ? { command: args.command, parameters: args.parameters }
          : { command: args.command };
      const result = await client.command(endpoint, body);
      return result ?? `Command '${args.command}' completed`;
    },
  }),
];
