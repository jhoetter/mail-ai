#!/usr/bin/env node
/* eslint-disable */
/**
 * Postinstall script: stage @officeai/react-editors into the workspace
 * root `node_modules/` so the standalone @mailai/web app resolves the
 * same editor runtime as hof-os' /edit-asset surface. (The previous
 * @mailai/react-app embed bundle was retired alongside the hof-os
 * Approach C cutover; the mail UI now ships natively from
 * hof-components/modules/mailai.)
 *
 * Mirrors `ensure-officeai-react-editors.cjs` in hof-os almost
 * line-for-line. The version + tarball URL are pinned in
 * `<repo>/infra/officeai.lock.json`, which the office-ai release
 * workflow keeps in sync via a notify-* job.
 *
 * Soft-fails (exit 0) so a fresh clone, an unreachable lockfile, or a
 * broken release tarball never blocks `pnpm install` — the consuming
 * packages lazy-import the editor and degrade gracefully.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const https = require("node:https");
const { execSync } = require("node:child_process");

const PKG = "@officeai/react-editors";
const STAMP_FILENAME = ".officeai-react-editors.version";

function log(msg) {
  process.stdout.write(`[officeai-react-editors] ${msg}\n`);
}

function warn(msg) {
  process.stderr.write(`[officeai-react-editors] ${msg}\n`);
}

/**
 * Walk up from `start` looking for `infra/officeai.lock.json`. Returns
 * `{ repoRoot, lockfilePath }` or `null`. Fix for the historical bug in
 * hof-os' script where `REPO_ROOT` was referenced but never defined —
 * we now derive both pieces of state from a single walk.
 */
function findRepo(start) {
  let dir = path.resolve(start);
  for (let i = 0; i < 8; i += 1) {
    const candidate = path.join(dir, "infra", "officeai.lock.json");
    if (fs.existsSync(candidate)) return { repoRoot: dir, lockfilePath: candidate };
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function readLockfile(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (err) {
    warn(`Lockfile parse error: ${err && err.message ? err.message : err}`);
    return null;
  }
}

function downloadFollow(url, dest, depth) {
  if (depth > 5) return Promise.reject(new Error(`Too many redirects: ${url}`));
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https
      .get(url, (res) => {
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          file.close(() => {});
          if (fs.existsSync(dest)) fs.unlinkSync(dest);
          resolve(downloadFollow(res.headers.location, dest, depth + 1));
          return;
        }
        if (!res.statusCode || res.statusCode >= 400) {
          file.close(() => {});
          if (fs.existsSync(dest)) fs.unlinkSync(dest);
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          return;
        }
        res.pipe(file);
        file.on("finish", () => file.close(() => resolve()));
      })
      .on("error", (err) => {
        file.close(() => {});
        if (fs.existsSync(dest)) fs.unlinkSync(dest);
        reject(err);
      });
  });
}

/**
 * Mirrors hof-os's `shamefullyHoistDeployedTree`: pnpm parks transitive
 * deps under `.pnpm/...` which `resolve.preserveSymlinks: true` cannot
 * see. Symlink each `.pnpm/<entry>/node_modules/<pkg>` up one level so
 * Node's walk-up resolver finds it. First-wins on dupes; idempotent.
 */
function shamefullyHoistDeployedTree(targetDir) {
  const nodeModulesDir = path.join(targetDir, "node_modules");
  const pnpmDir = path.join(nodeModulesDir, ".pnpm");
  if (!fs.existsSync(pnpmDir)) return;
  const seen = new Set();
  for (const pnpmEntry of fs.readdirSync(pnpmDir)) {
    const innerNm = path.join(pnpmDir, pnpmEntry, "node_modules");
    if (!fs.existsSync(innerNm)) continue;
    for (const pkg of fs.readdirSync(innerNm)) {
      if (pkg === ".bin") continue;
      if (pkg.startsWith("@")) {
        const scopeDir = path.join(innerNm, pkg);
        let scopeEntries;
        try {
          scopeEntries = fs.readdirSync(scopeDir);
        } catch {
          continue;
        }
        for (const sub of scopeEntries) {
          const fullName = `${pkg}/${sub}`;
          if (seen.has(fullName)) continue;
          seen.add(fullName);
          const target = path.join(nodeModulesDir, pkg, sub);
          if (fs.lstatSync(target, { throwIfNoEntry: false })) continue;
          fs.mkdirSync(path.dirname(target), { recursive: true });
          const real = path.join(scopeDir, sub);
          fs.symlinkSync(path.relative(path.dirname(target), real), target);
        }
      } else {
        if (seen.has(pkg)) continue;
        seen.add(pkg);
        const target = path.join(nodeModulesDir, pkg);
        if (fs.lstatSync(target, { throwIfNoEntry: false })) continue;
        const real = path.join(innerNm, pkg);
        fs.symlinkSync(path.relative(path.dirname(target), real), target);
      }
    }
  }
}

function ensureFromSiblingRepo(repoRoot) {
  const siblingRoot = path.resolve(repoRoot, "..", "office-ai");
  const siblingPkg = path.join(siblingRoot, "packages", "react-editors", "package.json");
  if (!fs.existsSync(siblingPkg)) return false;
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(siblingPkg, "utf8"));
  } catch (err) {
    warn(`Sibling repo manifest unreadable: ${err && err.message ? err.message : err}`);
    return false;
  }
  const version = manifest.version || "0.0.0-dev";
  const stamp = `sibling@${version}`;
  const targetDir = path.join(repoRoot, "node_modules", "@officeai", "react-editors");
  const stampFile = path.join(targetDir, STAMP_FILENAME);
  if (fs.existsSync(stampFile)) {
    try {
      if (fs.readFileSync(stampFile, "utf8").trim() === stamp) {
        log(`Already at ${stamp}; nothing to do.`);
        return true;
      }
    } catch {
      /* re-stage */
    }
  }
  log(`Staging ${PKG} from sibling repo (v${version})`);
  const stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "officeai-re-sibling-"));
  try {
    execSync(`pnpm --filter ${PKG} --prod deploy "${stageRoot}/officeai-react-editors"`, {
      cwd: siblingRoot,
      stdio: "inherit",
    });
    const stagedDir = path.join(stageRoot, "officeai-react-editors");
    const distEntry = path.join(stagedDir, "dist", "index.js");
    if (!fs.existsSync(distEntry)) {
      throw new Error(`pnpm deploy missing ${distEntry}; did 'pnpm build' run?`);
    }
    fs.mkdirSync(path.dirname(targetDir), { recursive: true });
    if (fs.existsSync(targetDir)) fs.rmSync(targetDir, { recursive: true, force: true });
    fs.renameSync(stagedDir, targetDir);
    shamefullyHoistDeployedTree(targetDir);
    fs.writeFileSync(stampFile, stamp);
    log(`Installed at ${targetDir}`);
    return true;
  } catch (err) {
    warn(`Sibling staging failed: ${err && err.message ? err.message : err}`);
    return false;
  } finally {
    try {
      fs.rmSync(stageRoot, { recursive: true, force: true });
    } catch {}
  }
}

async function main() {
  const repo = findRepo(__dirname);
  if (!repo) {
    log("Skip: no infra/officeai.lock.json found in any parent directory.");
    return;
  }
  const lock = readLockfile(repo.lockfilePath);
  const tarball = (lock && lock.react_editors_tarball) || "";
  const version = (lock && (lock.react_editors_version || lock.version)) || "";

  if (!tarball || !version) {
    log(
      "Skip tarball install: lockfile missing react_editors_tarball / version (bump office-ai release).",
    );
    if (ensureFromSiblingRepo(repo.repoRoot)) return;
    log(
      "No sibling office-ai checkout; @officeai/react-editors will be unavailable until the lockfile is updated.",
    );
    return;
  }

  const targetDir = path.join(repo.repoRoot, "node_modules", "@officeai", "react-editors");
  const stampFile = path.join(targetDir, STAMP_FILENAME);
  if (fs.existsSync(stampFile)) {
    try {
      if (fs.readFileSync(stampFile, "utf8").trim() === version) {
        log(`Already at v${version}; nothing to do.`);
        return;
      }
    } catch {
      /* re-install */
    }
  }

  log(`Installing ${PKG} v${version} from ${tarball}`);
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "officeai-re-"));
  const tarPath = path.join(tmpRoot, "bundle.tgz");
  try {
    await downloadFollow(tarball, tarPath, 0);
    execSync(`tar xzf "${tarPath}" -C "${tmpRoot}"`, { stdio: "inherit" });
    const extracted = path.join(tmpRoot, "officeai-react-editors");
    if (!fs.existsSync(extracted)) {
      throw new Error(`Extracted tarball missing expected directory: ${extracted}`);
    }
    fs.mkdirSync(path.dirname(targetDir), { recursive: true });
    if (fs.existsSync(targetDir)) fs.rmSync(targetDir, { recursive: true, force: true });
    fs.renameSync(extracted, targetDir);
    shamefullyHoistDeployedTree(targetDir);
    fs.writeFileSync(stampFile, version);
    log(`Installed at ${targetDir}`);
  } finally {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {}
  }
}

main().catch((err) => {
  warn(`Install failed: ${err && err.message ? err.message : err}`);
  process.exit(0);
});
