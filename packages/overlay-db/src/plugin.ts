// OverlayPlugin: registers ONLY IMAP-side commands and the audit sink.
// Domain commands (`thread:*`, `comment:*`) are owned by the
// collaboration plugin; this file is intentionally narrow so that
// `OverlayPlugin` and `CollaborationPlugin` can coexist on the same
// CommandBus without colliding.

import { CommandBus, type Command, type HandlerResult } from "@mailai/core";
import type { Database } from "./client.js";

export interface OverlayPluginDeps {
  readonly db: Database;
  readonly tenantId: string;
}

export class OverlayPlugin {
  readonly name = "overlay";
  constructor(private readonly _deps: OverlayPluginDeps) {}

  register(bus: CommandBus): void {
    bus.register("mail:mark-read", async (cmd: Command): Promise<HandlerResult> => {
      const { accountId, mailboxPath, uid } = cmd.payload as {
        accountId: string;
        mailboxPath: string;
        uid: number;
      };
      return {
        before: [],
        after: [],
        imapSideEffects: [
          { kind: "set-flag", accountId, mailbox: mailboxPath, uid, flag: "\\Seen" },
        ],
      };
    });

    bus.register("mail:mark-unread", async (cmd: Command): Promise<HandlerResult> => {
      const { accountId, mailboxPath, uid } = cmd.payload as {
        accountId: string;
        mailboxPath: string;
        uid: number;
      };
      return {
        before: [],
        after: [],
        imapSideEffects: [
          { kind: "unset-flag", accountId, mailbox: mailboxPath, uid, flag: "\\Seen" },
        ],
      };
    });
  }
}
