#!/usr/bin/env node
// Dry-run the publishable artifacts so CI catches packaging regressions
// before a tag is pushed. Mirrors scripts/bundle-dry-run.mjs in office-ai.

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";

const targets = ["packages/agent", "packages/react-app"];

for (const t of targets) {
  if (!existsSync(t + "/package.json")) {
    console.log(`skip: ${t} (no package.json yet)`);
    continue;
  }
  console.log(`\n== ${t} ==`);
  try {
    execSync(`pnpm --filter ./${t} pack --pack-destination /tmp/mailai-pack`, {
      stdio: "inherit",
    });
  } catch {
    console.error(`bundle:dry-run failed for ${t}`);
    process.exit(1);
  }
}
console.log("\nbundle:dry-run: ok");
