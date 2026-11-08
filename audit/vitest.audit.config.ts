import { defineConfig } from "vitest/config";
import path from "node:path";
const root = path.resolve(__dirname, "..");
export default defineConfig({
  root,
  resolve: { alias: { "@": root, "server-only": path.resolve(__dirname, "tests/stub-server-only.ts") } },
  test: { environment: "node", include: ["audit/tests/**/*.audit.ts"], testTimeout: 120_000 },
});
