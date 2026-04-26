#!/usr/bin/env node

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = readJson(join(ROOT, "hofos-ui.config.json"));
const HOF_OS = resolve(ROOT, CONFIG.hofOsPath ?? "../hof-os");
const CONTRACT_PATH = join(HOF_OS, "infra", "sister-ui-contract.json");
const CONTRACT = readJson(CONTRACT_PATH);
const PRODUCT = CONTRACT.products[CONFIG.product];
const OUT_ROOT = resolve(ROOT, CONFIG.export?.outDir ?? "release-out/hofos-ui");
const EXPORT_ROOT = join(OUT_ROOT, `${CONFIG.product}-ui-source`);
const FILES_ROOT = join(EXPORT_ROOT, "files");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function git(args) {
  try {
    return execSync(`git ${args}`, { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function shouldExclude(path) {
  const normalized = path.split(/[\\/]/).join("/");
  return PRODUCT.export.exclude.some((pattern) => {
    if (pattern === "**/node_modules/**") return normalized.includes("/node_modules/");
    if (pattern === "**/dist/**") return normalized.includes("/dist/");
    if (pattern === "**/__tests__/**") return normalized.includes("/__tests__/");
    if (pattern === "**/main.tsx")
      return normalized.endsWith("/main.tsx") || normalized === "main.tsx";
    if (pattern === "**/*.test.ts") return normalized.endsWith(".test.ts");
    if (pattern === "**/*.test.tsx") return normalized.endsWith(".test.tsx");
    return false;
  });
}

function listFiles(root, base = root) {
  const entries = readdirSync(root).sort();
  const files = [];
  for (const entry of entries) {
    const path = join(root, entry);
    const rel = relative(base, path);
    if (shouldExclude(rel)) continue;
    const stat = statSync(path);
    if (stat.isDirectory()) {
      files.push(...listFiles(path, base));
    } else if (stat.isFile()) {
      files.push(rel.split(/[\\/]/).join("/"));
    }
  }
  return files;
}

function hashFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

rmSync(EXPORT_ROOT, { force: true, recursive: true });
mkdirSync(FILES_ROOT, { recursive: true });

const exportedPaths = [];

for (const [destination, source] of Object.entries(PRODUCT.export.destinations)) {
  const sourcePath = join(ROOT, source);
  if (!existsSync(sourcePath)) {
    throw new Error(`missing export source ${source}`);
  }
  const destPath = join(FILES_ROOT, destination);
  mkdirSync(dirname(destPath), { recursive: true });
  cpSync(sourcePath, destPath, {
    recursive: true,
    filter(path) {
      return !shouldExclude(relative(sourcePath, path));
    },
  });
  exportedPaths.push(...listFiles(destPath).map((p) => `${destination}/${p}`));
}

const manifest = {
  schemaVersion: 1,
  product: CONFIG.product,
  sourceRepo: PRODUCT.sourceRepo,
  sourceSha: git("rev-parse HEAD"),
  sourceDirty: Boolean(git("status --porcelain")),
  exportVersion: readJson(join(ROOT, "package.json")).version,
  generatedAt: new Date().toISOString(),
  contractVersion: CONTRACT.version,
  contractHash: hashFile(CONTRACT_PATH),
  proxyPrefix: PRODUCT.proxyPrefix,
  hostRoutes: PRODUCT.hostRoutes,
  targetModule: PRODUCT.export.targetModule,
  preserve: PRODUCT.export.preserve,
  destinations: PRODUCT.export.destinations,
  exportedPaths: exportedPaths.sort(),
};

writeFileSync(
  join(EXPORT_ROOT, "hofos-ui-export-manifest.json"),
  JSON.stringify(manifest, null, 2) + "\n",
);
console.log(`exported ${exportedPaths.length} files to ${relative(ROOT, EXPORT_ROOT)}`);
