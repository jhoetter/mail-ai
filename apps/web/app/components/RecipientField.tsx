// Chip-style recipient input with a Gmail-grade autocomplete dropdown.
//
// Composer + InlineReply both render this for To / Cc / Bcc. The
// component is the only piece in the web app that talks to
// /api/contacts/suggest; everything else (Composer, ThreadView, draft
// autosave) keeps its existing `string[]` recipient contract.
//
// Behaviour we copied straight from Gmail:
//   - Comma, semicolon, Enter, Tab, and blur all "commit" the
//     in-progress chip.
//   - ArrowUp / ArrowDown / Enter operate on the dropdown when it's
//     open; Escape dismisses it without committing.
//   - Tab commits the highlighted suggestion if one is highlighted,
//     otherwise it commits whatever raw text is in the field.
//   - Backspace on an empty input deletes the last chip (matches
//     Gmail and React-Select muscle memory).
//
// ARIA pattern: textbox + listbox combobox (the "1.2 Combobox With
// List Autocomplete" variant in WAI-ARIA APG). The textbox owns
// `aria-controls` to the listbox id and `aria-activedescendant` to
// the highlighted option's id; the listbox is rendered next to it
// (visually below) so screen readers traverse them in order.
//
// We do NOT validate addresses here — Composer's `mail:send`
// payload is the source of truth for "what counts as a recipient";
// the server rejects anything malformed via the existing
// schema. This keeps the field forgiving (display names, group
// aliases, etc.) and the validation in one place.

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { X as RemoveIcon } from "lucide-react";
import { useTranslator } from "../lib/i18n/useTranslator";
import {
  useDebouncedSuggest,
  type ContactSource,
  type ContactSuggestion,
} from "../lib/contacts-client";

interface Props {
  readonly value: string[];
  readonly onChange: (next: string[]) => void;
  readonly placeholder?: string;
  // Restricts suggestions to one OAuth account. Optional — when
  // unset, the suggest endpoint searches all of the tenant's
  // contacts (matches the per-tenant inbox model the rest of the
  // app uses).
  readonly accountId?: string;
  readonly ariaLabel?: string;
  readonly autoFocus?: boolean;
}

const COMMIT_KEYS = new Set(["Enter", "Tab", ",", ";"]);

export function RecipientField({
  value,
  onChange,
  placeholder,
  accountId,
  ariaLabel,
  autoFocus,
}: Props) {
  const { t } = useTranslator();
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listboxId = useId();
  const optionIdPrefix = useId();

  const suggest = useDebouncedSuggest(draft, {
    enabled: open && draft.trim().length > 0,
    ...(accountId ? { accountId } : {}),
    limit: 8,
  });

  // Filter out anything already chipped so the dropdown never
  // suggests "this person you've already added" — same as Gmail.
  const filteredItems = useMemo(() => {
    const taken = new Set(value.map((v) => v.toLowerCase()));
    return suggest.items.filter((it) => !taken.has(it.email.toLowerCase()));
  }, [suggest.items, value]);

  // Reset the highlight when the result set changes; otherwise the
  // index can point past the new shorter list.
  useEffect(() => {
    setHighlight(0);
  }, [filteredItems.length]);

  const commit = useCallback(
    (raw: string) => {
      const trimmed = raw.trim().replace(/[,;]\s*$/, "");
      if (trimmed.length === 0) return;
      const lower = trimmed.toLowerCase();
      if (value.some((v) => v.toLowerCase() === lower)) {
        setDraft("");
        return;
      }
      onChange([...value, trimmed]);
      setDraft("");
      setOpen(false);
    },
    [onChange, value],
  );

  const commitSuggestion = useCallback(
    (s: ContactSuggestion) => {
      const formatted = s.name && s.name.length > 0 ? `${s.name} <${s.email}>` : s.email;
      commit(formatted);
    },
    [commit],
  );

  const removeAt = useCallback(
    (idx: number) => {
      const next = value.slice();
      next.splice(idx, 1);
      onChange(next);
      // After removing, focus the input so keyboard-only flows can
      // keep editing without reaching for the mouse.
      inputRef.current?.focus();
    },
    [onChange, value],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (open && filteredItems.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setHighlight((h) => (h + 1) % filteredItems.length);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setHighlight((h) => (h - 1 + filteredItems.length) % filteredItems.length);
          return;
        }
        if (e.key === "Enter") {
          e.preventDefault();
          const chosen = filteredItems[highlight];
          if (chosen) commitSuggestion(chosen);
          return;
        }
        if (e.key === "Tab") {
          // Tab commits the highlighted suggestion when the dropdown
          // is open AND the user has typed something. If they
          // haven't typed anything, fall through to the default
          // focus-move behaviour.
          if (draft.trim().length > 0) {
            e.preventDefault();
            const chosen = filteredItems[highlight];
            if (chosen) commitSuggestion(chosen);
          }
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setOpen(false);
          return;
        }
      }
      if (e.key === "Backspace" && draft.length === 0 && value.length > 0) {
        e.preventDefault();
        removeAt(value.length - 1);
        return;
      }
      if (COMMIT_KEYS.has(e.key) && draft.trim().length > 0) {
        if (e.key === "Tab") return; // let focus advance after commit
        e.preventDefault();
        commit(draft);
        return;
      }
    },
    [commit, commitSuggestion, draft, filteredItems, highlight, open, removeAt, value.length],
  );

  const onBlur = useCallback(() => {
    // Slight delay so a click on a dropdown option still has a chance
    // to land before the field commits + closes.
    queueMicrotask(() => {
      if (draft.trim().length > 0) commit(draft);
      setOpen(false);
    });
  }, [commit, draft]);

  const onFocus = useCallback(() => {
    if (draft.trim().length > 0) setOpen(true);
  }, [draft]);

  const onPaste = useCallback(
    (e: React.ClipboardEvent<HTMLInputElement>) => {
      const text = e.clipboardData.getData("text/plain");
      if (!text || !/[,;\n]/.test(text)) return;
      e.preventDefault();
      const parts = text.split(/[,;\n]/).map((p) => p.trim()).filter(Boolean);
      if (parts.length === 0) return;
      const taken = new Set(value.map((v) => v.toLowerCase()));
      const additions: string[] = [];
      for (const p of parts) {
        const lower = p.toLowerCase();
        if (taken.has(lower)) continue;
        taken.add(lower);
        additions.push(p);
      }
      if (additions.length > 0) {
        onChange([...value, ...additions]);
      }
      setDraft("");
    },
    [onChange, value],
  );

  const showDropdown = open && draft.trim().length > 0;
  const activeId =
    showDropdown && filteredItems.length > 0
      ? `${optionIdPrefix}-opt-${highlight}`
      : undefined;

  return (
    <div className="relative flex w-full min-w-0 flex-1 flex-wrap items-center gap-1">
      {value.map((addr, idx) => (
        <span
          key={`${addr}-${idx}`}
          className="inline-flex items-center gap-1 rounded-full border border-divider bg-surface px-2 py-0.5 text-xs text-foreground"
        >
          <span className="max-w-[16rem] truncate">{addr}</span>
          <button
            type="button"
            className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-full text-tertiary hover:bg-divider hover:text-foreground"
            aria-label={t("contacts.removeRecipient", { email: addr })}
            onClick={() => removeAt(idx)}
            tabIndex={-1}
          >
            <RemoveIcon size={10} aria-hidden />
          </button>
        </span>
      ))}
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        aria-expanded={showDropdown}
        aria-controls={listboxId}
        aria-autocomplete="list"
        {...(activeId ? { "aria-activedescendant": activeId } : {})}
        {...(ariaLabel ? { "aria-label": ariaLabel } : {})}
        autoFocus={autoFocus}
        className="min-w-[8rem] flex-1 bg-transparent px-1 text-sm text-foreground outline-none placeholder:text-tertiary"
        placeholder={value.length === 0 ? placeholder : undefined}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          setOpen(e.target.value.trim().length > 0);
        }}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
        onFocus={onFocus}
        onPaste={onPaste}
      />
      {showDropdown ? (
        <ul
          id={listboxId}
          role="listbox"
          aria-label={t("contacts.suggestionsLabel")}
          className="absolute left-0 top-full z-50 mt-1 max-h-64 w-full min-w-[16rem] max-w-[28rem] overflow-y-auto rounded-md border border-divider bg-background shadow-lg"
        >
          {filteredItems.length === 0 ? (
            <li className="px-3 py-2 text-xs text-tertiary">
              {suggest.loading ? t("contacts.loading") : t("contacts.noResults")}
            </li>
          ) : (
            filteredItems.map((item, idx) => (
              <li
                key={item.id}
                id={`${optionIdPrefix}-opt-${idx}`}
                role="option"
                aria-selected={idx === highlight}
                className={`flex cursor-pointer items-center justify-between gap-2 px-3 py-1.5 text-sm ${
                  idx === highlight
                    ? "bg-divider text-foreground"
                    : "text-foreground hover:bg-surface"
                }`}
                onMouseEnter={() => setHighlight(idx)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  commitSuggestion(item);
                }}
              >
                <span className="min-w-0 flex-1 truncate">
                  {item.name ? (
                    <>
                      <span className="font-medium">{item.name}</span>{" "}
                      <span className="text-tertiary">&lt;{item.email}&gt;</span>
                    </>
                  ) : (
                    <span>{item.email}</span>
                  )}
                </span>
                <SourcePill source={item.source} />
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}

interface SourcePillProps {
  readonly source: ContactSource;
}

function SourcePill({ source }: SourcePillProps) {
  const { t } = useTranslator();
  const label =
    source === "my"
      ? t("contacts.sourceMy")
      : source === "other"
        ? t("contacts.sourceOther")
        : source === "people"
          ? t("contacts.sourcePeople")
          : assertNever(source);
  return (
    <span className="shrink-0 rounded-full border border-divider px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-tertiary">
      {label}
    </span>
  );
}

function assertNever(x: never): never {
  throw new Error(`Unexpected source: ${String(x)}`);
}
