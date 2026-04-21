import { defineConfig } from "@playwright/test";

// Phase 5 Validate Playwright config. Tests are gated on the
// MAILAI_E2E env var so CI can opt in once Greenmail + the API
// server are wired in. Locally: `MAILAI_E2E=1 pnpm --filter
// @mailai/web test:e2e`.

const baseURL = process.env["MAILAI_WEB_URL"] ?? "http://127.0.0.1:3200";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  retries: 0,
  use: {
    baseURL,
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  reporter: [["list"]],
  projects: [{ name: "chromium" }],
});
