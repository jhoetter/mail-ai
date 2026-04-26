#!/usr/bin/env node
// release-tarballs.mjs
//
// Produces the publishable artifact (per docs/release-pipeline.md):
//
//   - mail-ai-agent-<version>.tgz       (the @mailai/agent CLI)
//
// Plus a `mailai.lock.json` snapshot that pins versions + shasums
// so a host repo can vendor it deterministically. We do NOT publish
// to npm here — release publishing is a manual step gated on review.
//
// The previous `mail-ai-react-app-<version>.tgz` artifact was
// retired alongside `packages/react-app/` after the hof-os Approach
// C cutover; the mail UI now ships natively from
// hof-components/modules/mailai.

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = process.env["MAILAI_RELEASE_DIR"] ?? join(ROOT, "release-out");
mkdirSync(OUT, { recursive: true });

const targets = [{ dir: "packages/agent", name: "@mailai/agent" }];

const lock = { generatedAt: new Date().toISOString(), packages: [] };

for (const t of targets) {
  const pkgJson = JSON.parse(readFileSync(join(ROOT, t.dir, "package.json"), "utf8"));
  console.log(`\n== ${t.name}@${pkgJson.version} ==`);
  execSync(`pnpm --filter ${t.name} pack --pack-destination ${OUT}`, {
    stdio: "inherit",
    cwd: ROOT,
  });

  const tarball = readdirSync(OUT)
    .filter((f) => f.endsWith(".tgz") && f.includes(t.name.replace("@", "").replace("/", "-")))
    .map((f) => ({ f, mtime: statSync(join(OUT, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0];
  if (!tarball) throw new Error(`no tarball produced for ${t.name}`);

  const buf = readFileSync(join(OUT, tarball.f));
  const shasum = createHash("sha256").update(buf).digest("hex");
  lock.packages.push({ name: t.name, version: pkgJson.version, tarball: tarball.f, shasum });
}

const lockPath = join(OUT, "mailai.lock.json");
import("node:fs").then(({ writeFileSync }) =>
  writeFileSync(lockPath, JSON.stringify(lock, null, 2) + "\n"),
);
console.log(`\nwrote ${lockPath}`);
console.log("release-tarballs: ok");
void existsSync; // referenced for clarity
