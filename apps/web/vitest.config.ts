import { defineConfig } from "vitest/config";

// We deliberately scope unit tests to small pure helpers under app/
// (i18n catalogue parity, calendar-time math, event-layout packing).
// Component tests live in apps/web/e2e (Playwright). Excluding e2e
// here keeps `pnpm --filter @mailai/web test` fast and node-only.
export default defineConfig({
  test: {
    include: ["app/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "e2e/**"],
    environment: "node",
  },
});
