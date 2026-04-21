// Per-account, per-provider connection pool. Per prompt.md:
//   Gmail: 15 concurrent IMAP connections per user
//   Microsoft: 20
//   Other IMAP: configurable, default 5
// Pool is in-memory; if mail-ai scales horizontally, an additional
// distributed lease via Redis (BullMQ) is layered on top — this keeps
// the inner implementation simple.

import { ImapConnection } from "./connection.js";
import type { AccountCredentials, Provider } from "./types.js";

const PROVIDER_LIMIT: Record<Provider, number> = {
  gmail: 15,
  microsoft: 20,
  imap: 5,
};

interface PoolEntry {
  readonly connection: ImapConnection;
  inUse: boolean;
  lastUsed: number;
}

export class ImapConnectionPool {
  private readonly entries: PoolEntry[] = [];
  private readonly waiters: Array<(c: ImapConnection) => void> = [];

  constructor(
    private readonly accountId: string,
    private readonly creds: AccountCredentials,
  ) {}

  get limit(): number {
    return PROVIDER_LIMIT[this.creds.provider];
  }

  async acquire(): Promise<ImapConnection> {
    const free = this.entries.find((e) => !e.inUse);
    if (free) {
      free.inUse = true;
      free.lastUsed = Date.now();
      return free.connection;
    }
    if (this.entries.length < this.limit) {
      const conn = new ImapConnection(this.creds);
      await conn.connect();
      const entry: PoolEntry = { connection: conn, inUse: true, lastUsed: Date.now() };
      this.entries.push(entry);
      return conn;
    }
    return new Promise<ImapConnection>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  release(conn: ImapConnection): void {
    const e = this.entries.find((x) => x.connection === conn);
    if (!e) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      e.lastUsed = Date.now();
      waiter(conn);
      return;
    }
    e.inUse = false;
    e.lastUsed = Date.now();
  }

  async closeAll(): Promise<void> {
    for (const e of this.entries) await e.connection.close();
    this.entries.length = 0;
  }

  get id(): string {
    return this.accountId;
  }
}
