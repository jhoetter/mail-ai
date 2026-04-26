#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_PATH = join(ROOT, "hofos-ui.config.json");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function dependencyMap(pkgJson) {
  return {
    ...pkgJson.dependencies,
    ...pkgJson.peerDependencies,
    ...pkgJson.devDependencies,
  };
}

function major(version) {
  const cleaned = String(version ?? "").replace(/^[^\d]*/, "");
  const match = cleaned.match(/^(\d+)/);
  return match ? Number(match[1]) : null;
}

function collectPackageJsons(root) {
  const candidates = [
    "package.json",
    "apps/web/package.json",
    "packages/ui/package.json",
    "packages/core/package.json",
    "packages/agent/package.json",
  ];
  return candidates
    .map((p) => join(root, p))
    .filter((p) => existsSync(p))
    .map((path) => ({ path, json: readJson(path) }));
}

function fail(message) {
  console.error(`hofos-ui-contract: ${message}`);
  process.exitCode = 1;
}

const config = readJson(CONFIG_PATH);
const hofOsPath = resolve(ROOT, config.hofOsPath ?? "../hof-os");
const contractPath = join(hofOsPath, "infra", "sister-ui-contract.json");
const contract = readJson(contractPath);
const product = contract.products[config.product];

if (!product) {
  fail(`unknown product ${config.product}`);
  process.exit();
}

if (config.harness?.requiredProxyPrefix !== product.proxyPrefix) {
  fail(`proxy prefix mismatch: expected ${product.proxyPrefix}`);
}

for (const route of product.hostRoutes) {
  const sample = route
    .replace(":threadId", "example-thread")
    .replace(":channelId", "example")
    .replace(":messageId", "example-message");
  if (!config.harness?.requiredRoutes?.includes(sample)) {
    fail(`harness missing required route ${sample}`);
  }
}

for (const [destination, source] of Object.entries(product.export.destinations)) {
  if (!existsSync(join(ROOT, source))) {
    fail(`export source missing for ${destination}: ${source}`);
  }
}

const hostPkgPath = join(hofOsPath, contract.host.uiPackageJson);
const hostDeps = dependencyMap(readJson(hostPkgPath));
const localPackages = collectPackageJsons(ROOT);
const allowedSkew = contract.dependencyPolicy.temporaryAllowedMajorSkew?.[config.product] ?? {};
const warnings = [];

for (const packageName of contract.dependencyPolicy.packages) {
  const hostVersion = hostDeps[packageName];
  if (!hostVersion) continue;

  for (const local of localPackages) {
    const localVersion = dependencyMap(local.json)[packageName];
    if (!localVersion || localVersion.startsWith("workspace:")) continue;
    const hostMajor = major(hostVersion);
    const localMajor = major(localVersion);
    if (hostMajor === null || localMajor === null || hostMajor === localMajor) continue;

    const location = relative(ROOT, local.path);
    if (allowedSkew[packageName]) {
      warnings.push(
        `${packageName} ${localVersion} in ${location} vs hofOS ${hostVersion}: ${allowedSkew[packageName]}`,
      );
    } else {
      fail(`${packageName} major skew in ${location}: ${localVersion} vs hofOS ${hostVersion}`);
    }
  }
}

for (const warning of warnings) {
  console.warn(`hofos-ui-contract warning: ${warning}`);
}

if (process.exitCode) {
  console.error(`hofos-ui-contract: failed against ${relative(ROOT, contractPath)}`);
  process.exit(process.exitCode);
}

console.log(`hofos-ui-contract: ok (${config.product})`);
