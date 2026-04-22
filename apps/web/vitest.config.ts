import { defineConfig } from "vitest/config";

// We deliberately scope unit tests to the i18n catalogue parity
// check (and any future small pure helpers in app/lib). Component
// tests live in apps/web/e2e (Playwright). Excluding e2e here keeps
// `pnpm --filter @mailai/web test` fast and node-only.
export default defineConfig({
  test: {
    include: ["app/lib/**/*.test.ts"],
    environment: "node",
  },
});
