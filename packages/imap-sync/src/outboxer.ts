// Outboxer: translates abstract overlay side-effects into concrete IMAP
// operations. Handlers in the overlay never call IMAP directly; instead
// they emit `ImapSideEffect[]` on the Mutation, and a worker (or, for
// dev/sync-tests, a direct call) drives this outboxer.
//
// All operations are UID-based and tagged with the mailbox path. Failure
// of a single side-effect aborts the remainder for that batch and is
// surfaced to the bus so the overlay can roll back.

import type { ImapConnection } from "./connection.js";
import { MailaiError } from "@mailai/core";

export type ImapSideEffect =
  | { kind: "set-flag"; mailbox: string; uid: number; flag: string }
  | { kind: "unset-flag"; mailbox: string; uid: number; flag: string }
  | { kind: "move"; mailbox: string; uid: number; toMailbox: string }
  | { kind: "expunge"; mailbox: string; uid: number }
  | { kind: "append"; mailbox: string; raw: Buffer; flags?: readonly string[] };

export interface SideEffectResult {
  readonly effect: ImapSideEffect;
  readonly ok: boolean;
  readonly error?: { code: string; message: string };
  readonly newUid?: number;
}

export class Outboxer {
  constructor(private readonly conn: ImapConnection) {}

  async run(effects: readonly ImapSideEffect[]): Promise<SideEffectResult[]> {
    const client = this.conn.raw();
    if (!client) throw new MailaiError("internal_error", "connection not open");
    const results: SideEffectResult[] = [];
    for (const effect of effects) {
      try {
        switch (effect.kind) {
          case "set-flag": {
            const lock = await client.getMailboxLock(effect.mailbox);
            try {
              await client.messageFlagsAdd({ uid: String(effect.uid) }, [effect.flag], { uid: true });
            } finally {
              lock.release();
            }
            results.push({ effect, ok: true });
            break;
          }
          case "unset-flag": {
            const lock = await client.getMailboxLock(effect.mailbox);
            try {
              await client.messageFlagsRemove({ uid: String(effect.uid) }, [effect.flag], { uid: true });
            } finally {
              lock.release();
            }
            results.push({ effect, ok: true });
            break;
          }
          case "move": {
            const lock = await client.getMailboxLock(effect.mailbox);
            try {
              await client.messageMove({ uid: String(effect.uid) }, effect.toMailbox, { uid: true });
            } finally {
              lock.release();
            }
            results.push({ effect, ok: true });
            break;
          }
          case "expunge": {
            const lock = await client.getMailboxLock(effect.mailbox);
            try {
              await client.messageDelete({ uid: String(effect.uid) }, { uid: true });
            } finally {
              lock.release();
            }
            results.push({ effect, ok: true });
            break;
          }
          case "append": {
            const flags = effect.flags ? Array.from(effect.flags) : undefined;
            const appendRes = await client.append(effect.mailbox, effect.raw, flags);
            const out: SideEffectResult = { effect, ok: true };
            if (appendRes && typeof appendRes === "object" && "uid" in appendRes && typeof appendRes.uid === "number") {
              (out as { newUid?: number }).newUid = appendRes.uid;
            }
            results.push(out);
            break;
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const code = (err as { code?: string }).code ?? "imap_error";
        results.push({ effect, ok: false, error: { code, message } });
        break; // abort remainder
      }
    }
    return results;
  }
}

export async function appendRawToSent(
  conn: ImapConnection,
  sentMailbox: string,
  raw: Buffer,
): Promise<{ uid?: number }> {
  const client = conn.raw();
  if (!client) throw new MailaiError("internal_error", "connection not open");
  const res = await client.append(sentMailbox, raw, ["\\Seen"]);
  if (res && typeof res === "object" && "uid" in res && typeof res.uid === "number") {
    return { uid: res.uid };
  }
  return {};
}
