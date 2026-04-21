// esbuild bundle for the publishable embed package.
// Mirrors office-ai's packages/react-editors/build.mjs:
//   - alias @/ → apps/web/app so the bundle re-uses the same source
//     tree as the standalone Next shell (single source of truth)
//   - alias next/link → ./src/shims/next-link.tsx for non-Next hosts
//   - inline @mailai/ui + @mailai/design-tokens (raw TS) so Vite hosts
//     don't need workspace resolution
//   - externalize React + heavy deps so the host owns those copies

import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../..");

const entries = [
  "src/components/inbox.ts",
  "src/components/thread.ts",
  "src/components/compose.ts",
  "src/blanks.ts",
  "src/contract.ts",
  "src/MailAiApp.tsx",
  "src/index.ts",
];

await build({
  entryPoints: entries.map((e) => resolve(here, e)),
  outdir: resolve(here, "dist"),
  format: "esm",
  bundle: true,
  platform: "browser",
  target: "es2022",
  jsx: "automatic",
  sourcemap: true,
  external: ["react", "react-dom", "react/jsx-runtime"],
  alias: {
    "@": resolve(ROOT, "apps/web/app"),
    "next/link": resolve(here, "src/shims/next-link.tsx"),
  },
  loader: { ".css": "copy" },
  logLevel: "info",
});
console.log("react-app: built");
