import { defineConfig } from "vitest/config";

export default defineConfig({
  ssr: { resolve: { conditions: ["react-server"] } },
  test: {
    include: ["tests/integration/**/*.test.ts"],
    environment: "node",
    testTimeout: 15_000,
    hookTimeout: 15_000,
    sequence: { concurrent: false },
  },
});
