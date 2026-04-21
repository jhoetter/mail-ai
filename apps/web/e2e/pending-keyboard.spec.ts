// e2e: pending-approvals page keyboard surface.
//
// Walks the documented `spec/frontend/keyboard.md` shortcut bindings
// for the approvals queue: `j/k` move selection, `y` approves, `n`
// prompts for a reason and rejects. Backed by Playwright's headless
// chromium running against `pnpm --filter @mailai/web dev`.
//
// Skipped unless MAILAI_E2E=1 so day-to-day vitest runs stay fast.

import { test, expect } from "@playwright/test";

test.skip(!process.env["MAILAI_E2E"], "set MAILAI_E2E=1 to run end-to-end suites");

test("pending page approves with the y shortcut", async ({ page }) => {
  await page.goto("/pending");
  await page.getByRole("row").nth(1).click();
  await page.keyboard.press("y");
  await expect(page.getByText(/awaiting review/)).toBeVisible();
});

test("pending page rejects with the n shortcut and prompts for reason", async ({ page }) => {
  await page.goto("/pending");
  await page.getByRole("row").nth(1).click();
  page.once("dialog", (d) => d.accept("not relevant"));
  await page.keyboard.press("n");
  await expect(page.getByText(/awaiting review/)).toBeVisible();
});
