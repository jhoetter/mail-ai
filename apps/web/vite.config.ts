import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";
import tailwindcss from "@tailwindcss/vite";

const API_ORIGIN =
  process.env["MAILAI_API_ORIGIN"] ?? "http://127.0.0.1:8200";

// Vite config for the mail-ai web SPA.
//
// Dev runs on :3200 (matches the legacy Next setup so existing OAuth
// callbacks, browser bookmarks, and dev scripts keep working). All
// /api/* requests are proxied to the upstream backend so the browser
// stays same-origin and we don't have to configure CORS for a single
// localhost port.
//
// In prod, the SPA is served from any static host and talks to the
// API directly via VITE_MAILAI_API_URL — the proxy is dev-only.
export default defineConfig({
  plugins: [
    react(),
    tsconfigPaths(),
    tailwindcss(),
  ],
  server: {
    port: 3200,
    strictPort: true,
    proxy: {
      "/api": {
        target: API_ORIGIN,
        changeOrigin: true,
      },
    },
  },
  preview: {
    port: 3200,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
