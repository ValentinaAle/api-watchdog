import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: { alias: { "@api-watchdog/validation": fileURLToPath(new URL("./packages/validation/src/index.ts", import.meta.url)) } },
  test: { include: ["tests/unit/**/*.test.ts"], environment: "node" },
});
