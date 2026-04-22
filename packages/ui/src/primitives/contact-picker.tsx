import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { cn } from "../lib/cn";

// Status dot shown next to attendee chips. Maps onto Google's RSVP
// states; "needsAction" / undefined render with no dot.
export type ContactPickerResponse =
  | "accepted"
  | "declined"
  | "tentative"
  | "needsAction";

export interface ContactPickerValue {
  readonly email: string;
  readonly name?: string;
  readonly response?: ContactPickerResponse;
  readonly organizer?: boolean;
}

export interface ContactSuggestion {
  readonly id: string;
  readonly email: string;
  readonly name?: string;
  readonly source?: string;
}

interface Props {
  value: ReadonlyArray<ContactPickerValue>;
  onChange: (value: ReadonlyArray<ContactPickerValue>) => void;
  // Async lookup; throttled by the picker. Returns at most ~8
  // suggestions. Consumers wire this to /api/contacts/suggest.
  onSearch?: (q: string) => Promise<ReadonlyArray<ContactSuggestion>>;
  placeholder?: string;
  // When true, we don't allow add/remove (used when the current user
  // isn't the organizer).
  readOnly?: boolean;
  className?: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Chip-input attendee picker. Types: free-form -> Enter / Tab / `,` to
// commit; backspace on an empty input pops the last chip; arrow keys
// navigate the suggestion list.
export function ContactPicker({
  value,
  onChange,
  onSearch,
  placeholder,
  readOnly = false,
  className,
}: Props) {
  const [input, setInput] = useState("");
  const [open, setOpen] = useState(false);
  const [suggestions, setSuggestions] = useState<ReadonlyArray<ContactSuggestion>>([]);
  const [hi, setHi] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const known = useMemo(
    () => new Set(value.map((v) => v.email.toLowerCase())),
    [value],
  );

  const commit = useCallback(
    (entry: ContactPickerValue) => {
      const lower = entry.email.toLowerCase();
      if (!EMAIL_RE.test(entry.email)) return;
      if (known.has(lower)) {
        setInput("");
        return;
      }
      onChange([...value, entry]);
      setInput("");
      setOpen(false);
    },
    [known, onChange, value],
  );

  const remove = useCallback(
    (email: string) => {
      onChange(value.filter((v) => v.email.toLowerCase() !== email.toLowerCase()));
    },
    [onChange, value],
  );

  // Debounced search.
  useEffect(() => {
    if (!onSearch) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (input.trim().length < 1) {
      setSuggestions([]);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      try {
        const items = await onSearch(input.trim());
        setSuggestions(items);
        setHi(0);
        setOpen(items.length > 0);
      } catch {
        setSuggestions([]);
      }
    }, 120);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [input, onSearch]);

  const handleKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === "Tab" || e.key === ",") {
      if (open && suggestions[hi]) {
        e.preventDefault();
        const s = suggestions[hi];
        commit({ email: s.email, ...(s.name ? { name: s.name } : {}) });
        return;
      }
      if (input.trim().length > 0) {
        e.preventDefault();
        commit({ email: input.trim() });
      }
    } else if (e.key === "Backspace" && input.length === 0 && value.length > 0) {
      e.preventDefault();
      remove(value[value.length - 1]!.email);
    } else if (e.key === "ArrowDown" && open) {
      e.preventDefault();
      setHi((i) => Math.min(i + 1, suggestions.length - 1));
    } else if (e.key === "ArrowUp" && open) {
      e.preventDefault();
      setHi((i) => Math.max(i - 1, 0));
    } else if (e.key === "Escape" && open) {
      e.preventDefault();
      setOpen(false);
    }
  };

  return (
    <div
      className={cn(
        "relative flex min-h-[2.25rem] w-full flex-wrap items-center gap-1 rounded-md border border-divider bg-surface px-1.5 py-1 text-sm",
        "focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/40",
        readOnly && "opacity-75",
        className,
      )}
      onClick={() => inputRef.current?.focus()}
    >
      {value.map((v) => (
        <span
          key={v.email}
          className={cn(
            "inline-flex items-center gap-1 rounded-full bg-hover px-2 py-0.5 text-xs",
            v.organizer && "ring-1 ring-accent/30",
          )}
        >
          <ResponseDot {...(v.response ? { response: v.response } : {})} />
          <span className="font-medium text-foreground">{v.name ?? v.email}</span>
          {v.name && (
            <span className="text-tertiary">&lt;{v.email}&gt;</span>
          )}
          {!readOnly && !v.organizer && (
            <button
              type="button"
              aria-label={`Remove ${v.email}`}
              onClick={(e) => {
                e.stopPropagation();
                remove(v.email);
              }}
              className="ml-0.5 inline-flex h-4 w-4 items-center justify-center rounded-full text-tertiary hover:bg-divider hover:text-foreground"
            >
              ×
            </button>
          )}
        </span>
      ))}
      {!readOnly && (
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKey}
          onFocus={() => suggestions.length > 0 && setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          placeholder={value.length === 0 ? placeholder : undefined}
          className="flex-1 min-w-[8rem] bg-transparent px-1 py-0.5 text-sm outline-none placeholder:text-tertiary"
        />
      )}
      {open && suggestions.length > 0 && (
        <div
          role="listbox"
          className="absolute left-0 right-0 top-full z-20 mt-1 max-h-64 overflow-auto rounded-md border border-divider bg-background py-1 shadow-lg"
        >
          {suggestions.map((s, i) => (
            <button
              key={s.id}
              type="button"
              role="option"
              aria-selected={i === hi}
              onMouseDown={(e) => {
                e.preventDefault();
                commit({ email: s.email, ...(s.name ? { name: s.name } : {}) });
              }}
              onMouseEnter={() => setHi(i)}
              className={cn(
                "flex w-full flex-col items-start gap-0.5 px-3 py-1.5 text-left text-sm",
                i === hi ? "bg-hover" : "bg-transparent",
              )}
            >
              <span className="font-medium text-foreground">
                {s.name ?? s.email}
              </span>
              {s.name && (
                <span className="text-xs text-tertiary">{s.email}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ResponseDot({ response }: { response?: ContactPickerResponse }) {
  if (!response || response === "needsAction") return null;
  const cls =
    response === "accepted"
      ? "bg-success"
      : response === "declined"
        ? "bg-error"
        : "bg-warning";
  return <span className={cn("inline-block h-2 w-2 rounded-full", cls)} aria-hidden />;
}
