#!/usr/bin/env node
// mail-agent CLI launcher.
//
// In a published install the build output sits next to this file at
// ../dist/cli.js and we just import it. In a fresh workspace clone
// (no build yet) we fall back to running the TypeScript source via
// `tsx`. This makes `pnpm install` succeed without first running
// `pnpm build`, which is the chicken-and-egg pnpm warns about.

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const built = resolve(here, "..", "dist", "cli.js");
const src = resolve(here, "..", "src", "cli.ts");

if (existsSync(built)) {
  await import(pathToFileURL(built).href);
} else if (existsSync(src)) {
  const { spawn } = await import("node:child_process");
  const child = spawn(
    process.execPath,
    ["--import", "tsx", src, ...process.argv.slice(2)],
    { stdio: "inherit" },
  );
  child.on("exit", (code) => process.exit(code ?? 0));
} else {
  process.stderr.write("mail-agent: neither dist/cli.js nor src/cli.ts found\n");
  process.exit(5);
}
