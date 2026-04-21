import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../lib/cn.js";

// Tiny self-contained dialog (no Radix dep). Accessibility is sufficient
// for the v1 surface — keyboard close, focus trap is left to consumers.
interface Props extends HTMLAttributes<HTMLDivElement> {
  open: boolean;
  onClose: () => void;
  children?: ReactNode;
}

export function Dialog({ open, onClose, className, children, ...rest }: Props) {
  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      className={cn(
        "fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4",
        className,
      )}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
      {...rest}
    >
      <div className="max-w-lg w-full rounded-lg border border-border bg-bg p-6 shadow-lg">
        {children}
      </div>
    </div>
  );
}
