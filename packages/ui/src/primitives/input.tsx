import type { InputHTMLAttributes } from "react";
import { cn } from "../lib/cn";

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "flex h-9 w-full rounded-md border border-divider bg-surface px-3 py-1.5 text-sm leading-normal text-foreground transition-colors duration-150",
        "placeholder:text-tertiary",
        "hover:border-tertiary",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:border-accent",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...rest}
    />
  );
}
