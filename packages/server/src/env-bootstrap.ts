// Loads the workspace `.env` into `process.env` if it exists.
//
// `make dev` already exports the file via `-include .env / export` in
// the Makefile, but running `pnpm dev` (or `pnpm turbo run dev`)
// directly bypasses that path and the server boots without any of the
// S3_*, NANGO_* etc. variables — which silently degrades attachments
// to InMemoryObjectStore and surfaces as "Upload fehlgeschlagen" in
// the composer.
//
// We deliberately don't pull in `dotenv`: a 30-line parser handles
// the same shape we already document in `.env.example` and keeps the
// server install footprint tiny. Existing env vars always win, so
// shell overrides and the Makefile path remain authoritative.

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function loadWorkspaceDotenv(): void {
  for (const path of candidatePaths()) {
    if (!existsSync(path)) continue;
    applyDotenvFile(path);
    return;
  }
}

function candidatePaths(): readonly string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  return [
    resolve(process.cwd(), ".env"),
    // Walk up from packages/server/src/ to the repo root.
    resolve(here, "..", "..", "..", ".env"),
  ];
}

function applyDotenvFile(path: string): void {
  const content = readFileSync(path, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
