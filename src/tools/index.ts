// The complete tool registry. [LAW:one-type-per-behavior] all variability lives
// in these data entries; registration is one loop in registry.ts.

import type { ToolDef } from "./registry.js";
import { statusTools } from "./status.js";
import { measurementTools } from "./measurements.js";
import { groupTools } from "./groups.js";
import { dataTools } from "./data.js";
import { measureTools } from "./measure.js";
import { importTools } from "./import.js";
import { generatorTools } from "./generator.js";
import { splTools } from "./spl.js";
import { eqTools } from "./eq.js";
import { processTools } from "./process.js";
import { alignmentTools } from "./alignment.js";
import { analyzeTools } from "./analyze.js";
import { rtaTools } from "./rta.js";

export const allTools: ToolDef[] = [
  ...statusTools,
  ...measurementTools,
  ...groupTools,
  ...dataTools,
  ...measureTools,
  ...importTools,
  ...generatorTools,
  ...splTools,
  ...eqTools,
  ...processTools,
  ...alignmentTools,
  ...analyzeTools,
  ...rtaTools,
];

export { registerTools } from "./registry.js";
