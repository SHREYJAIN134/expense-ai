import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 30000,
    env: {
      AUTH_SECRET: "test-secret-test-secret-test-secret-0123456789",
      DATABASE_URL: ":memory:",
    },
  },
});
