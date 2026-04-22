"use client";

import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { Monitor, Moon, Sun, type LucideIcon } from "lucide-react";
import { cn } from "../lib/cn";

interface ThemeToggleProps {
  className?: string;
  /** Compact mode shows only the active icon as a cycling button. */
  compact?: boolean;
  /** Optional accessible labels — falls back to English if omitted. */
  labels?: { light?: string; dark?: string; system?: string };
}

type ThemeOption = {
  value: "light" | "dark" | "system";
  fallbackLabel: string;
  Icon: LucideIcon;
};

const OPTIONS: ThemeOption[] = [
  { value: "light", fallbackLabel: "Light", Icon: Sun },
  { value: "system", fallbackLabel: "System", Icon: Monitor },
  { value: "dark", fallbackLabel: "Dark", Icon: Moon },
];

export function ThemeToggle({ className, compact, labels }: ThemeToggleProps) {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const labelFor = (opt: ThemeOption) => labels?.[opt.value] ?? opt.fallbackLabel;

  if (!mounted) {
    return <div className={cn("h-7", compact ? "w-7" : "w-[104px]", className)} />;
  }

  if (compact) {
    const currentIdx = OPTIONS.findIndex((o) => o.value === theme);
    const current = OPTIONS[currentIdx >= 0 ? currentIdx : 1]!;
    const next = OPTIONS[(OPTIONS.indexOf(current) + 1) % OPTIONS.length]!;
    const Icon = current.Icon;
    return (
      <button
        type="button"
        onClick={() => setTheme(next.value)}
        className={cn(
          "flex h-7 w-7 items-center justify-center rounded-md text-secondary transition-colors duration-150 hover:bg-hover hover:text-foreground",
          className,
        )}
        title={`Theme: ${labelFor(current)}. Click for ${labelFor(next)}.`}
      >
        <Icon size={14} aria-hidden />
      </button>
    );
  }

  return (
    <div
      className={cn(
        "inline-flex items-center gap-0.5 rounded-md bg-hover p-0.5",
        className,
      )}
      role="radiogroup"
      aria-label="Theme"
    >
      {OPTIONS.map(({ value, Icon, fallbackLabel }) => {
        const label = labels?.[value] ?? fallbackLabel;
        const active = theme === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => setTheme(value)}
            className={cn(
              "flex h-6 items-center justify-center rounded px-2 transition-colors duration-150",
              active
                ? "bg-background text-foreground shadow-sm"
                : "text-secondary hover:text-foreground",
            )}
            title={label}
          >
            <Icon size={13} aria-hidden />
          </button>
        );
      })}
    </div>
  );
}

export type { ThemeToggleProps };
