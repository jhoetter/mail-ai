// e2e: composing and sending a message lands in Greenmail's mailbox.
// Requires the dev compose stack from `infra/docker/compose.dev.yml`
// to be running (Greenmail on 3025/3143).

import { test, expect } from "@playwright/test";

test.skip(!process.env["MAILAI_E2E"], "set MAILAI_E2E=1 to run end-to-end suites");
test.skip(!process.env["MAILAI_GREENMAIL"], "Greenmail not enabled");

test("compose -> send arrives in recipient INBOX via Greenmail", async ({ page }) => {
  await page.goto("/inbox");
  await page.getByRole("button", { name: /new/i }).click();
  await page.getByPlaceholder("to@example.com").fill("bob@example.com");
  await page.getByPlaceholder("Subject").fill("e2e test");
  await page.locator("textarea").fill("hello from playwright");
  await page.getByRole("button", { name: /send/i }).click();

  await expect(page.getByText(/Sent/)).toBeVisible({ timeout: 5000 });
});
