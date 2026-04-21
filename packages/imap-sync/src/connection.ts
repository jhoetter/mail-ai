// Thin wrapper around imapflow.ImapFlow. Centralises auth-mode wiring
// (XOAUTH2 vs password), structured error mapping, and the lifecycle
// `connect → use → close` so callers never leak sockets.

import { ImapFlow } from "imapflow";
import { MailaiError } from "@mailai/core";
import type { AccountCredentials } from "./types.js";

export class ImapConnection {
  private client: ImapFlow | null = null;
  constructor(private readonly creds: AccountCredentials) {}

  async connect(): Promise<ImapFlow> {
    if (this.client) return this.client;
    const auth =
      this.creds.auth.kind === "password"
        ? { user: this.creds.username, pass: this.creds.auth.password }
        : { user: this.creds.username, accessToken: this.creds.auth.accessToken };
    const client = new ImapFlow({
      host: this.creds.host,
      port: this.creds.port,
      secure: this.creds.secure,
      auth,
      logger: false,
      // imapflow auto-negotiates IDLE / CONDSTORE / QRESYNC.
    });
    try {
      await client.connect();
    } catch (err) {
      throw mapAuthOrNetworkError(err);
    }
    this.client = client;
    return client;
  }

  async close(): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.logout();
    } catch {
      // best-effort
    }
    this.client = null;
  }

  raw(): ImapFlow | null {
    return this.client;
  }
}

function mapAuthOrNetworkError(err: unknown): MailaiError {
  const msg = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: string }).code;
  if (code === "AUTHENTICATIONFAILED" || /AUTH/i.test(msg)) {
    return new MailaiError("auth_error", `IMAP authentication failed: ${msg}`, { cause: err });
  }
  if (code === "ECONNREFUSED" || code === "ETIMEDOUT" || code === "ENOTFOUND") {
    return new MailaiError("network_error", `IMAP connection failed: ${msg}`, { cause: err });
  }
  return new MailaiError("imap_error", msg, { cause: err });
}
