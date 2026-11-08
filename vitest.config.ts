import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
      // server-only throws when resolved via a bundler's non-Node condition,
      // which Vitest's default resolution triggers; it's a no-op under plain
      // Node/tsx, so a no-op alias here matches real runtime behavior.
      "server-only": path.resolve(__dirname, "tests/stubs/server-only.ts"),
    },
  },
  test: {
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["lib/agent/**", "lib/ingest/**", "app/api/**"],
    },
  },
});
