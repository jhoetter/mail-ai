#!/usr/bin/env node
// check-architecture.mjs
//
// Enforces the architecture invariants from prompt.md:
//
//  - Headless packages (core, mime, imap-sync, smtp-send, overlay-db,
//    collaboration, agent, server) must NOT import React, Next, or any
//    DOM/browser-only API.
//  - Only `packages/imap-sync` may import `imapflow`.
//  - Only `packages/overlay-db` may open Postgres connections (`pg`,
//    `drizzle-orm/node-postgres`).
//  - Only `packages/server` may open HTTP/WebSocket sockets (`fastify`,
//    `ws`).
//  - Only `packages/smtp-send` may import `nodemailer`.
//  - Browser packages (ui, design-tokens, react-app) and apps may
//    import React/Next freely.
//
// Failures exit with code 1 and print every offending file/import.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const HEADLESS = new Set([
  "core",
  "mime",
  "imap-sync",
  "smtp-send",
  "overlay-db",
  "collaboration",
  "agent",
  "server",
  "oauth-tokens",
]);

const FORBIDDEN_IN_HEADLESS = [
  /^react($|\/)/,
  /^react-dom($|\/)/,
  /^next($|\/)/,
  /^@radix-ui\//,
  /^tailwindcss($|\/)/,
];

const SCOPED = {
  imapflow: ["imap-sync"],
  pg: ["overlay-db"],
  "drizzle-orm/node-postgres": ["overlay-db"],
  fastify: ["server"],
  ws: ["server", "realtime-server"],
  nodemailer: ["smtp-send"],
  bullmq: ["imap-sync", "server"],
  ioredis: ["imap-sync", "server"],
};

const IMPORT_RE = /(?:from\s+["']([^"']+)["'])|(?:require\(\s*["']([^"']+)["']\s*\))/g;

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === ".next" || entry === ".turbo")
      continue;
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, files);
    else if (/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(entry)) files.push(p);
  }
  return files;
}

function packageName(file) {
  const rel = relative(ROOT, file);
  const m = rel.match(/^(packages|apps)\/([^/]+)\//);
  return m ? m[2] : null;
}

function imports(file) {
  const src = readFileSync(file, "utf8");
  const out = [];
  let m;
  while ((m = IMPORT_RE.exec(src))) {
    const spec = m[1] ?? m[2];
    if (spec) out.push(spec);
  }
  return out;
}

const errors = [];
const packagesDir = join(ROOT, "packages");
const appsDir = join(ROOT, "apps");

for (const base of [packagesDir, appsDir]) {
  let entries;
  try {
    entries = readdirSync(base);
  } catch {
    continue;
  }
  for (const pkg of entries) {
    const pkgDir = join(base, pkg);
    if (!statSync(pkgDir).isDirectory()) continue;
    const files = walk(pkgDir);
    for (const file of files) {
      const name = packageName(file);
      if (!name) continue;
      const imps = imports(file);
      for (const spec of imps) {
        if (HEADLESS.has(name)) {
          for (const re of FORBIDDEN_IN_HEADLESS) {
            if (re.test(spec)) {
              errors.push(`${relative(ROOT, file)}: forbidden import "${spec}" in headless package "${name}"`);
            }
          }
        }
        for (const [dep, allowed] of Object.entries(SCOPED)) {
          if (spec === dep || spec.startsWith(dep + "/")) {
            if (!allowed.includes(name)) {
              errors.push(
                `${relative(ROOT, file)}: import "${spec}" is only allowed in [${allowed.join(", ")}] (found in "${name}")`,
              );
            }
          }
        }
      }
    }
  }
}

if (errors.length > 0) {
  console.error("Architecture violations:");
  for (const e of errors) console.error("  - " + e);
  process.exit(1);
}
console.log("architecture: ok");
