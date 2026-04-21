import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Minimal Vite host that proves the @mailai/react-app bundle is
// drop-in usable. We deliberately do NOT import @mailai/* source
// modules — only the published bundle (or the workspace dist/
// during local dev) — so this file doubles as a smoke test for the
// embed contract (`spec/frontend/embed.md`).
export default defineConfig({
  plugins: [react()],
  resolve: {
    dedupe: ["react", "react-dom"],
  },
});
