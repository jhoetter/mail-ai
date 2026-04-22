/**
 * mail-ai default brand colors
 *
 * Notion-like aesthetic. Mirror of the office-ai / hof-os token shape so
 * a custom brand pack (e.g. `@mailai/brand-conservativ`) can ship a
 * stylesheet that overrides the same CSS variables and have the entire
 * UI follow without touching a single component.
 */
export const colors = {
  /* ── Light mode base ── */
  background: "#FFFFFF",
  foreground: "#37352F",
  secondary: "#787774",
  tertiary: "#C3C2C1",
  divider: "#E9E9E7",
  hover: "#F7F7F5",
  surface: "#FBFBFA",
  accent: "#2563EB",
  accentLight: "#EAF2FE",
  onAccent: "#FFFFFF",

  /* ── Dark mode base ── */
  backgroundDark: "#191919",
  foregroundDark: "#E3E2E0",
  secondaryDark: "#9B9A97",
  tertiaryDark: "#5A5A58",
  dividerDark: "#2F2F2F",
  hoverDark: "#252525",
  surfaceDark: "#202020",
  accentDark: "#60A5FA",
  accentLightDark: "#1E2D45",
  onAccentDark: "#0B1322",

  /* ── Semantic status ── */
  warning: "#E57A2E",
  error: "#D84B3E",
  info: "#787774",
  success: "#2F7D59",

  /* ── Neutral grays (kept for utilities) ── */
  gray50: "#FAFAFA",
  gray100: "#F5F5F5",
  gray200: "#E9E9E7",
  gray300: "#C3C2C1",
  gray400: "#9B9A97",
  gray500: "#787774",
  gray600: "#4B5563",
  gray700: "#374151",
  gray800: "#1F2937",
  gray900: "#111827",
} as const;

export type ColorToken = keyof typeof colors;
