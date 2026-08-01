import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // reference/ holds cloned upstream repos with their own suites — not ours to run.
    include: ["src/**/*.test.ts"],
  },
});
