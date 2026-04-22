// Centralized keyboard-shortcut hook. Auto-disables inside text
// inputs, contenteditable, and when meta-modifiers are held (so
// Cmd+R still reloads instead of triggering "reply"). Per
// `spec/frontend/keyboard.md` every shortcut here corresponds to
// a documented action; do not add ad-hoc bindings.

import { useEffect } from "react";

export type Shortcut = {
  readonly key: string;
  readonly meta?: boolean;
  readonly shift?: boolean;
  readonly run: () => void;
  readonly description: string;
};

function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  const tag = t.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select";
}

export function useShortcut(shortcuts: readonly Shortcut[]): void {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (isTypingTarget(e.target)) return;
      for (const s of shortcuts) {
        if (s.key !== e.key) continue;
        if (Boolean(s.meta) !== (e.metaKey || e.ctrlKey)) continue;
        if (Boolean(s.shift) !== e.shiftKey) continue;
        e.preventDefault();
        s.run();
        return;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shortcuts]);
}
