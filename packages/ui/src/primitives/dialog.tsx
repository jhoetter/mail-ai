import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../lib/cn";

interface Props extends HTMLAttributes<HTMLDivElement> {
  open: boolean;
  onClose: () => void;
  children?: ReactNode;
  /**
   * On phones, dialogs work much better as full-screen sheets than as
   * floating cards (no thumb-stretching, no keyboard cropping the
   * inputs). When `fullScreenOnMobile` is true (default) the dialog
   * fills the viewport below `sm`. Pass `false` for tiny confirm
   * dialogs that genuinely benefit from staying small.
   */
  fullScreenOnMobile?: boolean;
}

export function Dialog({
  open,
  onClose,
  className,
  children,
  fullScreenOnMobile = true,
  ...rest
}: Props) {
  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      className={cn(
        "fixed inset-0 z-50 flex items-stretch justify-center bg-foreground/40 sm:items-center sm:p-4",
        className,
      )}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
      {...rest}
    >
      <div
        className={cn(
          "flex w-full flex-col overflow-hidden bg-background shadow-lg sm:max-w-lg sm:rounded-lg sm:border sm:border-divider",
          fullScreenOnMobile
            ? // Phone: full viewport, no rounded edges; uses dynamic
              // viewport units so iOS Safari's URL bar doesn't crop
              // the bottom of the form.
              "h-[100dvh] sm:h-auto"
            : "h-auto rounded-lg border border-divider",
          // Inner padding stays at p-6 on desktop but tighter on
          // mobile so the form fields breathe a little less aggressively.
          "p-4 sm:p-6",
        )}
      >
        {children}
      </div>
    </div>
  );
}
