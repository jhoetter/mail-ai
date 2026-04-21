import type { InputHTMLAttributes } from "react";
import { cn } from "../lib/cn";

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "h-9 w-full rounded-md border border-border bg-bg px-3 text-sm text-fg outline-none focus:border-accent",
        className,
      )}
      {...rest}
    />
  );
}
