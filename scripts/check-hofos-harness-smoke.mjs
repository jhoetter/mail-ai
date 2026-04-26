#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const config = JSON.parse(readFileSync(join(ROOT, "hofos-ui.config.json"), "utf8"));

function fail(message) {
  console.error(`hofos-harness-smoke: ${message}`);
  process.exitCode = 1;
}

for (const route of [
  "/mail/inbox",
  "/mail/inbox/thread/example-thread",
  "/mail/settings/account",
  "/calendar",
]) {
  if (!config.harness.requiredRoutes.includes(route)) {
    fail(`missing route smoke coverage for ${route}`);
  }
}

if (config.harness.requiredProxyPrefix !== "/api/mail") {
  fail("expected /api/mail proxy prefix");
}

if (!/Office-AI/.test(config.harness.officeAiAttachmentContract)) {
  fail("missing Office-AI attachment contract");
}

const appShell = readFileSync(join(ROOT, "apps/web/app/lib/shell/AppShell.tsx"), "utf8");
if (!appShell.includes("go-calendar") || !appShell.includes("/settings/account")) {
  fail("Cmd+K smoke coverage must include calendar and account settings commands");
}

const appNav = readFileSync(join(ROOT, "apps/web/app/components/AppNav.tsx"), "utf8");
if (!appNav.includes("/calendar") || !appNav.includes("/settings/account")) {
  fail("navigation smoke coverage must include calendar and account settings links");
}

if (
  !existsSync(join(ROOT, "release-out/hofos-ui/mailai-ui-source/hofos-ui-export-manifest.json"))
) {
  console.warn(
    "hofos-harness-smoke warning: export manifest not present; run pnpm run export:hofos-ui before release.",
  );
}

if (process.exitCode) process.exit(process.exitCode);
console.log("hofos-harness-smoke: ok (mailai)");
