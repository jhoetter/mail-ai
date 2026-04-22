import { colors } from "./colors";
import { fontFamily } from "./typography";
import { borderRadius, borderWidth, maxWidth } from "./spacing";

/**
 * mail-ai Tailwind v3 preset.
 *
 * apps/web uses Tailwind v4 and emits the same tokens via CSS variables in
 * `globals.css` + the `styles.css` shipped from this package, so this preset
 * is only consumed by external embeds / hosts that still run Tailwind v3.
 */
export const mailAiPreset = {
  theme: {
    extend: {
      colors: {
        background: "var(--background)",
        foreground: "var(--foreground)",
        secondary: "var(--secondary)",
        tertiary: "var(--tertiary)",
        divider: "var(--divider)",
        hover: "var(--hover)",
        surface: "var(--surface)",
        accent: "var(--accent)",
        "accent-light": "var(--accent-light)",
        "on-accent": "var(--on-accent)",
        warning: colors.warning,
        error: colors.error,
        info: colors.info,
        success: colors.success,
      },
      fontFamily: {
        sans: fontFamily.sans,
        mono: fontFamily.mono,
      },
      borderRadius: { ...borderRadius },
      borderWidth: { ...borderWidth },
      maxWidth: { ...maxWidth },
    },
  },
};
