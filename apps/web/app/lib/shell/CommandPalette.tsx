// Cmd+K palette. Custom-built (no `cmdk` dep) so we can keep it
// trivial and predictable: substring + per-character matching with
// a tiny scoring function, recents in localStorage, and Esc / Enter
// / arrow-key navigation. The palette is rendered inside a portal
// so its position is independent of whoever called it.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslator } from "../i18n/useTranslator";
import { usePaletteRegistry } from "./paletteRegistry";
import type { PaletteCommand } from "./types";

const RECENTS_KEY = "mailai.palette.recent";
const RECENTS_LIMIT = 6;

export function CommandPalette() {
  const reg = usePaletteRegistry();
  const { t } = useTranslator();
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const commands = reg.list();
  const recents = useRecents();

  // Reset state when the palette closes so the next open lands on a
  // clean query and the first row.
  useEffect(() => {
    if (!reg.isOpen) {
      setQuery("");
      setActiveIdx(0);
      return;
    }
    // Focus the input on open. Wrapped in a microtask so the portal
    // has finished mounting.
    queueMicrotask(() => inputRef.current?.focus());
  }, [reg.isOpen]);

  const filtered = useMemo(
    () => filterAndSort(commands, query, recents),
    [commands, query, recents],
  );

  // Keep the active index in range whenever the filtered list
  // shrinks or the query changes.
  useEffect(() => {
    setActiveIdx((idx) => Math.min(Math.max(0, idx), Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  const runAt = useCallback(
    (idx: number) => {
      const cmd = filtered[idx];
      if (!cmd || cmd.enabled === false) return;
      pushRecent(cmd.id);
      reg.close();
      // Defer so close-state transitions don't tangle with route
      // changes inside the run handler.
      queueMicrotask(() => {
        try {
          void cmd.run?.();
        } catch (err) {
          console.error("[palette] command failed:", err);
        }
      });
    },
    [filtered, reg],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        reg.close();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIdx((i) => Math.min(filtered.length - 1, i + 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIdx((i) => Math.max(0, i - 1));
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        runAt(activeIdx);
      }
    },
    [activeIdx, filtered.length, reg, runAt],
  );

  if (!reg.isOpen) return null;

  // Render via portal so the palette overlays whatever sits beneath
  // it without needing a positioned ancestor.
  if (typeof document === "undefined") return null;

  // Group by section for the muted headers.
  const grouped = groupBySection(filtered);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 px-4 pt-[12vh]"
      onClick={() => reg.close()}
    >
      <div
        role="dialog"
        aria-label={t("palette.title")}
        className="w-full max-w-xl overflow-hidden rounded-lg border border-divider bg-background shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-divider">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={t("palette.placeholder")}
            className="h-12 w-full bg-transparent px-4 text-sm text-foreground outline-none placeholder:text-secondary"
            aria-label={t("palette.placeholder")}
          />
        </div>
        <div ref={listRef} className="max-h-[60vh] overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-secondary">{t("palette.empty")}</p>
          ) : (
            grouped.map((g) => (
              <div key={g.section} className="mb-1">
                <div className="px-3 pb-1 pt-2 text-[10px] uppercase tracking-wider text-secondary">
                  {g.section}
                </div>
                {g.commands.map((cmd) => {
                  const idx = filtered.indexOf(cmd);
                  const active = idx === activeIdx;
                  const disabled = cmd.enabled === false;
                  return (
                    <button
                      key={cmd.id}
                      type="button"
                      disabled={disabled}
                      className={
                        "flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-sm " +
                        (active
                          ? "bg-surface text-foreground"
                          : "text-foreground/90 hover:bg-surface/60") +
                        (disabled ? " opacity-50 cursor-not-allowed" : "")
                      }
                      onMouseEnter={() => setActiveIdx(idx)}
                      onClick={() => runAt(idx)}
                    >
                      <span className="flex flex-col">
                        <span>{cmd.label}</span>
                        {cmd.hint ? (
                          <span className="text-[11px] text-secondary">{cmd.hint}</span>
                        ) : null}
                      </span>
                      {cmd.shortcut ? (
                        <kbd className="rounded border border-divider bg-surface px-1.5 py-0.5 text-[10px] text-secondary">
                          {cmd.shortcut}
                        </kbd>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

interface Group {
  section: string;
  commands: PaletteCommand[];
}

function groupBySection(commands: readonly PaletteCommand[]): Group[] {
  const map = new Map<string, PaletteCommand[]>();
  for (const c of commands) {
    const s = c.section ?? "Other";
    let arr = map.get(s);
    if (!arr) {
      arr = [];
      map.set(s, arr);
    }
    arr.push(c);
  }
  return [...map.entries()].map(([section, cmds]) => ({ section, commands: cmds }));
}

// Score a command against the query. Higher is better. We do three
// things: (1) substring match on label, (2) substring match on hint,
// (3) word-boundary preference. We deliberately don't ship a fuzzy
// matcher — the command set is small and exact substrings are easier
// to predict.
function score(cmd: PaletteCommand, query: string): number {
  if (!query) return 0;
  const q = query.toLowerCase();
  const label = cmd.label.toLowerCase();
  const hint = (cmd.hint ?? "").toLowerCase();
  let s = 0;
  if (label.startsWith(q)) s += 100;
  if (label.includes(q)) s += 40;
  if (hint.includes(q)) s += 10;
  // Word-boundary bonus.
  if (new RegExp(`\\b${escapeRegex(q)}`).test(label)) s += 15;
  if (s === 0) {
    // Per-character ordered match (subsequence) as a fallback so
    // typing "ginb" still surfaces "Go to Inbox".
    let i = 0;
    for (const ch of label) {
      if (ch === q[i]) i++;
      if (i === q.length) break;
    }
    if (i === q.length) s = 5;
  }
  return s;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function filterAndSort(
  commands: readonly PaletteCommand[],
  query: string,
  recents: readonly string[],
): PaletteCommand[] {
  if (!query) {
    // No query → recents first (in MRU order), then the rest in their
    // declared order. Disabled commands are sorted last but kept
    // visible so the user knows the action exists.
    const recentSet = new Set(recents);
    const recentOrdered: PaletteCommand[] = recents
      .map((id) => commands.find((c) => c.id === id))
      .filter((c): c is PaletteCommand => Boolean(c));
    const others = commands.filter((c) => !recentSet.has(c.id));
    return [...recentOrdered, ...others].sort(disabledLast);
  }
  return commands
    .map((c) => ({ c, s: score(c, query) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.c)
    .sort(disabledLast);
}

function disabledLast(a: PaletteCommand, b: PaletteCommand): number {
  const ad = a.enabled === false ? 1 : 0;
  const bd = b.enabled === false ? 1 : 0;
  return ad - bd;
}

function useRecents(): readonly string[] {
  const [list, setList] = useState<readonly string[]>([]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(RECENTS_KEY);
      if (!raw) return;
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        setList(parsed.filter((v): v is string => typeof v === "string"));
      }
    } catch {
      /* ignore */
    }
  }, []);
  return list;
}

function pushRecent(id: string): void {
  if (typeof window === "undefined") return;
  try {
    const raw = window.localStorage.getItem(RECENTS_KEY);
    const existing = raw ? (JSON.parse(raw) as unknown) : [];
    const list = (Array.isArray(existing) ? existing : []).filter(
      (v): v is string => typeof v === "string" && v !== id,
    );
    list.unshift(id);
    window.localStorage.setItem(RECENTS_KEY, JSON.stringify(list.slice(0, RECENTS_LIMIT)));
  } catch {
    /* ignore */
  }
}
