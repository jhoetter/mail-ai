// IDLE listener with NOOP fallback for non-IDLE servers.
// Notifies a callback whenever the server reports new mail or flag
// changes. The actual delta sync is delegated to MailboxSyncer.

import type { ImapConnection } from "./connection.js";

export interface IdleEvent {
  readonly kind: "new-mail" | "flag-change" | "expunge" | "untagged";
}

export type IdleHandler = (e: IdleEvent) => void | Promise<void>;

export class IdleListener {
  private stopped = false;
  private noopTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly conn: ImapConnection,
    private readonly mailboxPath: string,
    private readonly handler: IdleHandler,
    private readonly opts: { fallbackPollMs?: number } = {},
  ) {}

  async start(): Promise<void> {
    const client = this.conn.raw();
    if (!client) throw new Error("connection not open");
    await client.mailboxOpen(this.mailboxPath);
    const supportsIdle = (
      client as { capability?: { has?: (s: string) => boolean } }
    ).capability?.has?.("IDLE");
    if (supportsIdle) {
      const onExists = () => this.handler({ kind: "new-mail" });
      const onFlags = () => this.handler({ kind: "flag-change" });
      const onExpunge = () => this.handler({ kind: "expunge" });
      client.on("exists", onExists);
      client.on("flags", onFlags);
      client.on("expunge", onExpunge);
      while (!this.stopped) {
        try {
          await client.idle();
        } catch {
          // Reconnect handled by caller (PoolEntry reconnects on error).
          break;
        }
      }
      client.off("exists", onExists);
      client.off("flags", onFlags);
      client.off("expunge", onExpunge);
    } else {
      // NOOP poll loop fallback.
      const poll = this.opts.fallbackPollMs ?? 30_000;
      this.noopTimer = setInterval(async () => {
        try {
          await client.noop();
          await this.handler({ kind: "untagged" });
        } catch {
          this.stop();
        }
      }, poll);
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.noopTimer) {
      clearInterval(this.noopTimer);
      this.noopTimer = null;
    }
  }
}
