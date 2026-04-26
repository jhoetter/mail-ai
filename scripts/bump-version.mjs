#!/usr/bin/env node
// Bump the version of every publishable package in lockstep.
// Usage: node scripts/bump-version.mjs <new-version>

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const target = process.argv[2];
if (!target || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(target)) {
  console.error("usage: bump-version.mjs <semver>");
  process.exit(1);
}

const PUBLISHABLE = ["packages/agent"];

for (const dir of PUBLISHABLE) {
  const pj = join(dir, "package.json");
  if (!existsSync(pj)) continue;
  const json = JSON.parse(readFileSync(pj, "utf8"));
  json.version = target;
  writeFileSync(pj, JSON.stringify(json, null, 2) + "\n");
  console.log(`bumped ${json.name} -> ${target}`);
}

// Touch root package.json too so release tags are easy to track.
const root = JSON.parse(readFileSync("package.json", "utf8"));
root.version = target;
writeFileSync("package.json", JSON.stringify(root, null, 2) + "\n");
console.log(`bumped root -> ${target}`);
