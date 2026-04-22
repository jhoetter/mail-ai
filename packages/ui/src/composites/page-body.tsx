import type { ReactNode } from "react";

interface Props {
  children: ReactNode;
  /**
   * Cap the readable column for settings/article-style pages. Defaults
   * to a comfortable mid-width that mirrors collaboration-ai's
   * channel/page max width. Pass `"none"` to opt out (e.g. for a
   * full-bleed dashboard).
   */
  width?: "default" | "wide" | "none";
}

// Padded scroll container for content pages that follow a slim
// PageHeader. Provides the breathing room and vertical rhythm
// (gap-3) the Shell deliberately omits, and caps the readable column
// so dense settings forms don't stretch across an ultra-wide monitor.
export function PageBody({ children, width = "default" }: Props) {
  const cap =
    width === "none" ? "" : width === "wide" ? "max-w-5xl" : "max-w-3xl";
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div
        className={`mx-auto flex flex-col gap-3 px-3 py-3 sm:px-4 sm:py-4 ${cap}`}
      >
        {children}
      </div>
    </div>
  );
}
