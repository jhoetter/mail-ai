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
//  - Browser packages (ui, design-tokens) and apps may
//    import React/Next freely. Note: `packages/react-app/` was
//    deleted after the hof-os Approach C cutover; the embed UI now
//    ships natively from hof-components/modules/mailai.
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

// Provider-specific transport modules inside @mailai/oauth-tokens.
// They live behind the MailProvider/CalendarProvider/ContactsProvider/
// PushProvider ports in @mailai/providers; only the adapter layer
// (packages/oauth-tokens/src/adapters) and oauth-tokens' own internal
// helpers may import them. Server handlers, routes, and the web app
// must go through the registry.
//
// We match BOTH the package-relative spec (`@mailai/oauth-tokens/...`)
// and source-relative specs (`./gmail.js`, `../graph.js`) used inside
// oauth-tokens itself.
const PROVIDER_INTERNAL_BARE = [
  "@mailai/oauth-tokens/dist/gmail",
  "@mailai/oauth-tokens/dist/graph",
  "@mailai/oauth-tokens/dist/send",
  "@mailai/oauth-tokens/dist/calendar",
  "@mailai/oauth-tokens/dist/contacts",
];
const PROVIDER_INTERNAL_RELATIVE_RE = /(^|\/)(?:gmail|graph|send|calendar|contacts)(?:\.[a-z]+)?$/;

// Files that *are* allowed to import the provider internals. The
// adapters are the boundary; the legacy oauth-tokens internal modules
// (refresher, helpers) and any oauth-tokens test that exercises the
// transport directly are also exempted. Any other file is a
// violation.
function isProviderInternalsAllowed(file) {
  const rel = relative(ROOT, file);
  if (rel.startsWith("packages/oauth-tokens/src/adapters/")) return true;
  // oauth-tokens internal cross-imports (e.g. send.ts → gmail.ts).
  // We allow anything inside oauth-tokens/src that isn't a server- or
  // app-level consumer. The package itself owns these helpers.
  if (rel.startsWith("packages/oauth-tokens/src/")) return true;
  return false;
}

const IMPORT_RE = /(?:from\s+["']([^"']+)["'])|(?:require\(\s*["']([^"']+)["']\s*\))/g;

// Catches the failure mode the port model exists to prevent: a server
// handler / web route / scheduler that branches on a provider id
// instead of asking the adapter via capabilities or a port method.
//
// Matches `<expr>.provider === "google-mail"` and the symmetric
// `=== "outlook"`/`=== "imap"` plus `!==` variants. We only flag
// equality comparisons so type narrowings via `if (x.provider) {}`
// or string interpolations that legitimately serialize the id stay
// allowed.
const PROVIDER_BRANCH_RE = /\bprovider\s*(?:===|!==|==|!=)\s*["'](?:google-mail|outlook|imap)["']/;

// Files that legitimately branch on provider id:
//   - Adapters (the boundary itself).
//   - oauth-tokens internals (refresher picks the OAuth refresh URL).
//   - Provider-specific webhook handlers (the route exists *because*
//     it is the Gmail/Graph webhook).
//   - This check script (it lists ids in its own pattern).
//   - Vitest specs that exercise per-provider behaviour.
function isProviderBranchAllowed(file) {
  const rel = relative(ROOT, file);
  if (rel.startsWith("packages/oauth-tokens/")) return true;
  if (rel === "scripts/check-architecture.mjs") return true;
  if (/\.test\.(ts|tsx|mts|cts|js|jsx)$/.test(rel)) return true;
  if (rel.startsWith("packages/server/src/routes/webhooks.")) return true;
  return false;
}

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
      if (!isProviderBranchAllowed(file)) {
        const src = readFileSync(file, "utf8");
        if (PROVIDER_BRANCH_RE.test(src)) {
          errors.push(
            `${relative(ROOT, file)}: branches on a provider id literal; use a capability flag on the adapter or add a port method instead`,
          );
        }
      }
      const imps = imports(file);
      for (const spec of imps) {
        if (HEADLESS.has(name)) {
          for (const re of FORBIDDEN_IN_HEADLESS) {
            if (re.test(spec)) {
              errors.push(
                `${relative(ROOT, file)}: forbidden import "${spec}" in headless package "${name}"`,
              );
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

        // Provider-internals boundary: only the adapter layer (and
        // oauth-tokens' own internals) may import the concrete REST
        // clients. Everything else has to go through @mailai/providers.
        //
        // We only match the package-relative spec here — relative
        // imports like `./calendar.js` are scoped to oauth-tokens by
        // construction (TypeScript wouldn't resolve them across
        // packages anyway), so checking package boundary is enough.
        const isInternalBare = PROVIDER_INTERNAL_BARE.some(
          (p) => spec === p || spec.startsWith(p + "."),
        );
        if (isInternalBare && !isProviderInternalsAllowed(file)) {
          errors.push(
            `${relative(ROOT, file)}: import "${spec}" reaches into provider internals; route through a @mailai/providers port + registry instead`,
          );
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
