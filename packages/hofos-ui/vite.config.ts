import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const here = fileURLToPath(new URL(".", import.meta.url));
const external = ["react", "react-dom", "react-dom/client", "react/jsx-runtime"];
const DESIGN_SYSTEM_IDS = ["default", "playful", "conservative"] as const;

function resolveDesignSystemId(): (typeof DESIGN_SYSTEM_IDS)[number] {
  const raw = (process.env.VITE_DESIGN_SYSTEM ?? process.env.DESIGN_SYSTEM ?? "default")
    .trim()
    .toLowerCase();
  return (DESIGN_SYSTEM_IDS as readonly string[]).includes(raw)
    ? (raw as (typeof DESIGN_SYSTEM_IDS)[number])
    : "default";
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(here, "../../apps/web/app"),
      "@mailai-hof-design-system.css": path.resolve(
        here,
        `../../apps/web/app/design-systems/${resolveDesignSystemId()}.css`,
      ),
    },
  },
  build: {
    cssCodeSplit: true,
    emptyOutDir: true,
    lib: {
      entry: "src/index.ts",
      formats: ["es"],
      fileName: "index",
    },
    outDir: "dist",
    rollupOptions: {
      external,
      output: {
        chunkFileNames: "chunks/[name]-[hash].js",
        assetFileNames: "[name][extname]",
      },
    },
    sourcemap: false,
  },
});
