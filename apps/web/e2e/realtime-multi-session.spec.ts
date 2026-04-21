// e2e: two browser contexts ("alice" and "bob") see each other's
// thread mutations within the documented 1s budget. The realtime
// transport is `apps/realtime-server` for presence + the
// `EventBroadcaster` in `@mailai/server` for command-bus mutations.

import { test, expect, chromium } from "@playwright/test";

test.skip(!process.env["MAILAI_E2E"], "set MAILAI_E2E=1 to run end-to-end suites");

test("alice's status flip reaches bob's open inbox tab", async () => {
  const browser = await chromium.launch();
  const aliceCtx = await browser.newContext();
  const bobCtx = await browser.newContext();
  const alice = await aliceCtx.newPage();
  const bob = await bobCtx.newPage();
  try {
    await Promise.all([alice.goto("/inbox"), bob.goto("/inbox")]);
    await alice.getByRole("row").nth(1).click();
    await alice.getByRole("button", { name: /resolve/i }).click();
    await expect(bob.getByText(/resolved/i)).toBeVisible({ timeout: 2000 });
  } finally {
    await browser.close();
  }
});
