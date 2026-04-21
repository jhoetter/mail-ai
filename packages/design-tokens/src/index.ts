// Design tokens for mail-ai. Notion-like aesthetic with light/dark
// mode, Tailwind v4 compatible. Mirrors the shape of @officeai/design-tokens
// so a future hof-os embed slots in cleanly.

export const tokens = {
  color: {
    bg: { light: "#ffffff", dark: "#0a0a0a" },
    fg: { light: "#0f172a", dark: "#f1f5f9" },
    muted: { light: "#64748b", dark: "#94a3b8" },
    accent: { light: "#2563eb", dark: "#60a5fa" },
    danger: { light: "#dc2626", dark: "#f87171" },
    success: { light: "#16a34a", dark: "#4ade80" },
    border: { light: "#e2e8f0", dark: "#1f2937" },
    surface: { light: "#f8fafc", dark: "#111827" },
  },
  radius: {
    sm: "4px",
    md: "8px",
    lg: "12px",
    xl: "16px",
  },
  font: {
    sans: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    mono: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  },
} as const;

export type Tokens = typeof tokens;
