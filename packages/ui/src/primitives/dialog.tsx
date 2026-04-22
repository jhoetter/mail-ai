import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../lib/cn";

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
        "fixed inset-0 z-50 flex items-center justify-center bg-foreground/40 p-4",
        className,
      )}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
      {...rest}
    >
      <div className="w-full max-w-lg rounded-lg border border-divider bg-background p-6 shadow-lg">
        {children}
      </div>
    </div>
  );
}
