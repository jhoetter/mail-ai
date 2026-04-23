// MailAiSearchInput — controlled search field that the host can drop
// into its own top-bar / chrome and have it emit submits as
// `/inbox?q=<value>` deep-links via the host's navigator.
//
// Phase A intentionally keeps this dumb: no debounce, no suggestions,
// no autocomplete. The host owns palette / debounce; this component
// is just a styled `<input>` that knows the canonical mail-ai search
// URL shape so hosts don't have to hardcode it.
//
// We deliberately do NOT wrap the input in a router — search is a
// presentation concern, and forcing a router context would prevent
// hosts from rendering it inside their own header outside any
// embedded `MailAi*` pane.

import { useCallback, type ChangeEvent, type FormEvent, type KeyboardEvent } from "react";

export interface MailAiSearchInputProps {
  readonly value: string;
  readonly onChange: (next: string) => void;
  readonly placeholder?: string;
  /**
   * Optional navigator. When provided, submitting (Enter / form
   * submit) calls `onSubmit("/inbox?q=<value>")`. When omitted the
   * input still updates `value` via `onChange` but never triggers
   * navigation — the host can wire up its own submit handling.
   */
  readonly onSubmit?: (path: string) => void;
}

export function MailAiSearchInput({
  value,
  onChange,
  placeholder,
  onSubmit,
}: MailAiSearchInputProps) {
  const handleChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      onChange(e.target.value);
    },
    [onChange],
  );

  const handleSubmit = useCallback(
    (path: string) => {
      if (onSubmit) onSubmit(path);
    },
    [onSubmit],
  );

  const onFormSubmit = useCallback(
    (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const trimmed = value.trim();
      handleSubmit(trimmed ? `/inbox?q=${encodeURIComponent(trimmed)}` : "/inbox");
    },
    [value, handleSubmit],
  );

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      // Belt-and-suspenders: handle Enter even when the input is
      // rendered outside a form (some hosts wrap their chrome with
      // a single global form for layout reasons; others don't).
      if (e.key === "Enter") {
        e.preventDefault();
        const trimmed = value.trim();
        handleSubmit(trimmed ? `/inbox?q=${encodeURIComponent(trimmed)}` : "/inbox");
      }
    },
    [value, handleSubmit],
  );

  return (
    <form onSubmit={onFormSubmit} className="w-full" role="search">
      <input
        type="search"
        value={value}
        onChange={handleChange}
        onKeyDown={onKeyDown}
        placeholder={placeholder ?? "Search mail"}
        className="w-full rounded-md border border-divider bg-background px-3 py-1.5 text-sm text-foreground placeholder:text-tertiary focus:border-foreground/30 focus:outline-none focus:ring-2 focus:ring-foreground/10"
      />
    </form>
  );
}
