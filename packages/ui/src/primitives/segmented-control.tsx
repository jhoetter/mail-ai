import type { ReactNode } from "react";
import { cn } from "../lib/cn";

export interface SegmentedControlOption<TValue extends string> {
  readonly value: TValue;
  readonly label: ReactNode;
  readonly disabled?: boolean;
  // Optional aria-label for icon-only segments.
  readonly ariaLabel?: string;
}

interface Props<TValue extends string> {
  readonly value: TValue;
  readonly options: ReadonlyArray<SegmentedControlOption<TValue>>;
  readonly onChange: (value: TValue) => void;
  readonly size?: "sm" | "md";
  readonly className?: string;
  readonly ariaLabel?: string;
}

// One-of-N picker rendered as a row of pill buttons. Used for the
// Day / Week / Month switcher and the "this event / this and
// following / all events" edit-scope picker.
export function SegmentedControl<TValue extends string>({
  value,
  options,
  onChange,
  size = "md",
  className,
  ariaLabel,
}: Props<TValue>) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn(
        "inline-flex items-center rounded-md border border-divider bg-surface p-0.5",
        className,
      )}
    >
      {options.map((opt) => {
        const selected = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={opt.ariaLabel}
            disabled={opt.disabled}
            onClick={() => {
              if (!opt.disabled && opt.value !== value) onChange(opt.value);
            }}
            className={cn(
              "inline-flex items-center justify-center rounded-[5px] font-medium transition-colors duration-150",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
              "disabled:opacity-50 disabled:pointer-events-none",
              size === "sm" ? "h-6 px-2 text-xs" : "h-7 px-3 text-xs",
              selected
                ? "bg-background text-foreground shadow-sm"
                : "text-secondary hover:text-foreground",
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
