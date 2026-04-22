// Types for the Cmd+K palette + AppShell registry.
//
// The shape mirrors office-ai's: a command is just an id, a label
// (already localized — callers pass `t("palette.foo.label")`), an
// optional run handler, and metadata that drives grouping and
// ranking. The registry is a React context so any leaf component
// can contribute scoped commands by mounting a hook.

export type CommandRun = () => void | Promise<void>;

export interface PaletteCommand {
  // Stable identifier. Used as React key, recents storage key, and
  // for de-dup when a page contributes the same command twice.
  readonly id: string;
  readonly label: string;
  // Optional secondary text shown muted to the right of the label
  // (e.g. shortcut hint, description, account email).
  readonly hint?: string;
  // Section header. Defaults to "Other" when missing.
  readonly section?: string;
  // Optional shortcut shown right-aligned. The palette does NOT bind
  // these globally — that's owned by useShortcut() in the components
  // that actually need them. The string is pure presentation.
  readonly shortcut?: string;
  // Disabling a command keeps it visible (so "Reply" doesn't
  // disappear when no thread is selected) but stops it from running.
  readonly enabled?: boolean;
  readonly run?: CommandRun;
}

export interface PaletteRegistry {
  // Snapshot of every command currently registered (static + scoped).
  list(): readonly PaletteCommand[];
  // Mount/unmount scoped commands. Returns an unregister fn.
  register(commands: readonly PaletteCommand[]): () => void;
  // Open / close.
  open(): void;
  close(): void;
  toggle(): void;
  readonly isOpen: boolean;
}
