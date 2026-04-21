import type { HTMLAttributes } from "react";
import { cn } from "../lib/cn";

export function Card({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("rounded-lg border border-border bg-surface p-4 shadow-sm", className)}
      {...rest}
    />
  );
}
