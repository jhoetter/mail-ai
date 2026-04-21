// Re-export the canonical Inbox component from apps/web. The build.mjs
// alias (`@` → apps/web/app) lets esbuild resolve this; the Next dev
// server resolves the same alias via tsconfig paths.
export { Inbox } from "@/components/Inbox";
