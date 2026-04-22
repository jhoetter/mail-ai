import type { ButtonHTMLAttributes } from "react";
import { cn } from "../lib/cn";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "accent";
type Size = "sm" | "md" | "lg" | "icon";

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

const VARIANTS: Record<Variant, string> = {
  // Primary uses the foreground colour for a Notion-flavoured "near-black"
  // button that flips to "near-white" in dark mode automatically.
  primary:
    "bg-foreground text-background hover:opacity-85 active:opacity-100",
  secondary:
    "bg-hover text-foreground hover:bg-divider active:bg-hover",
  ghost: "bg-transparent text-foreground hover:bg-hover active:bg-divider",
  danger: "bg-error/10 text-error hover:bg-error/20 active:bg-error/10",
  accent: "bg-accent text-on-accent hover:opacity-85 active:opacity-100",
};

const SIZES: Record<Size, string> = {
  sm: "h-7 px-2.5 text-xs rounded-md",
  md: "h-8 px-3 text-sm rounded-md",
  lg: "h-10 px-5 text-sm rounded-md",
  icon: "h-8 w-8 rounded-md",
};

export function Button({
  variant = "primary",
  size = "md",
  className,
  type = "button",
  ...rest
}: Props) {
  return (
    <button
      type={type}
      className={cn(
        "inline-flex items-center justify-center gap-2 whitespace-nowrap font-medium transition-colors duration-150",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-1",
        "disabled:pointer-events-none disabled:opacity-50",
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    />
  );
}
