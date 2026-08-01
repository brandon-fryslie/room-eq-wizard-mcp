import { z } from "zod";
import { defineTool } from "./registry.js";
import { unknownSchema } from "../rew/types.js";
import { listMeasurements } from "./shared.js";

export const statusTools = [
  defineTool({
    name: "status",
    description:
      "Check the REW API connection and report application state: reachability, measurement count, and any logged errors or warnings. Run this first if other tools fail.",
    inputSchema: {},
    handler: async (client) => {
      // Reachability is proven by the commands endpoint answering at all.
      await client.get("/application/commands", unknownSchema);
      const measurements = await listMeasurements(client);
      const errors = await client.get("/application/errors", unknownSchema);
      const warnings = await client.get("/application/warnings", unknownSchema);
      return {
        connected: true,
        apiUrl: client.baseUrl,
        measurementCount: measurements.length,
        errors,
        warnings,
      };
    },
  }),
  defineTool({
    name: "list_api_commands",
    description:
      "List the raw commands a REW endpoint area accepts (application, measurements, measure, generator, rta, or a specific measurement's commands). Useful to discover REW capabilities not covered by a dedicated tool.",
    inputSchema: {
      area: z
        .enum(["application", "measurements", "measure", "generator", "rta"])
        .describe("Which REW command list to read"),
    },
    handler: async (client, args) => {
      const paths = {
        application: "/application/commands",
        measurements: "/measurements/commands",
        measure: "/measure/commands",
        generator: "/generator/commands",
        rta: "/rta/commands",
      } as const;
      return client.get(paths[args.area], unknownSchema);
    },
  }),
];
