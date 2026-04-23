// Host-supplied contract for embedded mail-ai.
//
// Embedding hosts (hof-os; future enterprise customers) implement this
// object once and pass it to every embedded surface. mail-ai never
// reaches into host state directly — the only seams are these
// callbacks and the API URL.

export interface PresenceUser {
  readonly id: string;
  readonly name: string;
  readonly color?: string;
}

export interface AuthToken {
  readonly token: string;
  readonly expiresAt: number;
}

export interface MailaiHostHooks {
  /** Identity used for presence + audit log actor attribution. */
  readonly presenceUser: PresenceUser;
  /** mail-ai HTTP API base URL — no trailing slash. */
  readonly apiUrl: string;
  /** mail-ai WebSocket URL. */
  readonly wsUrl: string;
  /** Mount path inside the host SPA. The embed routes inside this prefix. */
  readonly mountPath: string;
  /** Returns a bearer token. Host owns refresh; mail-ai never persists. */
  onAuth(): Promise<AuthToken>;
  /** Optional: inspect every outbound mail before SMTP submit. */
  onBeforeSend?(draft: {
    to: readonly string[];
    subject: string;
    bodyHash: string;
  }): Promise<"allow" | "deny">;
}

// ──────────────────────────────────────────────────────────────────────
// Command palette contract (Phase A)
//
// Hosts that build their own ⌘K palette can call `mailaiCommands(ctx)`
// to get a flat list of mail-ai actions and merge them into their own
// command index. The shape is intentionally framework-agnostic — `id`
// is for de-dup, `group` drives section headers in the host's UI, and
// `perform()` is the only side-effecting hook (so the host can wrap
// it in its own analytics / undo stack).
// ──────────────────────────────────────────────────────────────────────

export interface CommandPaletteItem {
  /** Stable identifier — used for React keys and host de-dup. */
  readonly id: string;
  /** Section header in the host palette ("Mail", "Navigation", ...). */
  readonly group: string;
  /** Localized label shown to the user. */
  readonly label: string;
  /** Optional muted secondary text (e.g. description, account email). */
  readonly hint?: string;
  /** Presentation-only shortcut hint (e.g. "g i"). Not bound globally. */
  readonly shortcut?: string;
  /** Action to run when the host invokes the command. */
  perform(): void | Promise<void>;
  /** Optional ranking score; higher floats above. Defaults to 0 in hosts. */
  readonly score?: number;
}
