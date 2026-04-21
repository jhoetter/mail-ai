import { tokens } from "./index.js";

export default {
  theme: {
    extend: {
      colors: {
        bg: tokens.color.bg.light,
        fg: tokens.color.fg.light,
        muted: tokens.color.muted.light,
        accent: tokens.color.accent.light,
        danger: tokens.color.danger.light,
        success: tokens.color.success.light,
        border: tokens.color.border.light,
        surface: tokens.color.surface.light,
      },
      borderRadius: tokens.radius,
      fontFamily: {
        sans: tokens.font.sans,
        mono: tokens.font.mono,
      },
    },
  },
};
