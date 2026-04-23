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
