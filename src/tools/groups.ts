// REW's /groups endpoints manage measurement groups. Wire shapes pinned from
// reference/rew-mcp-server/Docs/rew_api.md §Groups: groups are addressed by
// UUID only (names are user-editable), a measurement joins a group via a POST
// of { uuid } — a MeasurementSummary with every other field omitted — to
// /groups/:uuid/measurements. The live suite verifies against a running REW.
// The API documents no way to remove a measurement from a group, so there is
// deliberately no tool for it.

import { z } from "zod";
import { defineTool, measurementIdInput } from "./registry.js";
import type { RewClient } from "../rew/client.js";
import { groupInfoSchema, groupListSchema, groupMeasurementsSchema } from "../rew/types.js";
import { resolveUuid } from "./shared.js";

const groupUuidInput = z.string().describe("Group UUID (from list_groups or create_group)");

async function addToGroup(
  client: RewClient,
  groupUuid: string,
  measurements: string[],
): Promise<string[]> {
  const added: string[] = [];
  for (const measurement of measurements) {
    const uuid = await resolveUuid(client, measurement);
    await client.post(`/groups/${encodeURIComponent(groupUuid)}/measurements`, { uuid });
    added.push(uuid);
  }
  return added;
}

export const groupTools = [
  defineTool({
    name: "list_groups",
    description:
      "List all measurement groups in REW, with UUID, name, and notes. Group UUIDs are the only stable way to reference a group in other tools.",
    inputSchema: {},
    handler: async (client) => client.get("/groups", groupListSchema),
  }),
  defineTool({
    name: "create_group",
    description:
      "Create a new measurement group, optionally placing measurements in it immediately. Fails if a group with the same name already exists. Returns the group including its UUID.",
    inputSchema: {
      name: z.string().describe("Group name, must not match an existing group"),
      notes: z.string().optional().describe("Notes stored with the group"),
      measurements: z
        .array(measurementIdInput)
        .default([])
        .describe("Measurements to place in the new group"),
    },
    handler: async (client, args) => {
      const group = groupInfoSchema.parse(
        await client.post("/groups", { name: args.name, notes: args.notes }),
      );
      try {
        const added = await addToGroup(client, group.uuid, args.measurements);
        return { ...group, addedCount: added.length, added };
      } catch (error) {
        // [LAW:no-silent-failure] the group exists even though membership
        // failed — surface its UUID so the caller recovers instead of
        // re-creating and hitting the duplicate-name rejection.
        throw new Error(
          `group '${args.name}' was created (uuid ${group.uuid}) but adding measurements failed: ${(error as Error).message}`,
        );
      }
    },
  }),
  defineTool({
    name: "update_group",
    description: "Change a group's name and/or notes.",
    inputSchema: {
      group: groupUuidInput,
      name: z.string().optional().describe("New name"),
      notes: z.string().optional().describe("New notes"),
    },
    handler: async (client, args) => {
      if (args.name === undefined && args.notes === undefined) {
        throw new Error("provide name, notes, or both");
      }
      await client.put(`/groups/${encodeURIComponent(args.group)}`, {
        name: args.name,
        notes: args.notes,
      });
      return `Updated group ${args.group}`;
    },
  }),
  defineTool({
    name: "delete_group",
    description:
      "Delete one measurement group by UUID. There is no confirmation and no undo — REW deletes immediately. The group's measurements are not deleted.",
    inputSchema: { group: groupUuidInput },
    handler: async (client, args) => {
      await client.delete(`/groups/${encodeURIComponent(args.group)}`);
      return `Deleted group ${args.group}`;
    },
  }),
  defineTool({
    name: "add_measurements_to_group",
    description:
      "Place one or more measurements in an existing group. Returns the UUIDs of the measurements added.",
    inputSchema: {
      group: groupUuidInput,
      measurements: z.array(measurementIdInput).min(1).describe("Measurements to place in the group"),
    },
    handler: async (client, args) => {
      const added = await addToGroup(client, args.group, args.measurements);
      return { addedCount: added.length, added };
    },
  }),
  defineTool({
    name: "get_group_measurements",
    description: "List the measurements currently in a group, as measurement summaries.",
    inputSchema: { group: groupUuidInput },
    handler: async (client, args) =>
      client.get(`/groups/${encodeURIComponent(args.group)}/measurements`, groupMeasurementsSchema),
  }),
];
