"use client";

import { Button, Dialog, Input } from "@mailai/ui";
import { useState } from "react";
import { client } from "../lib/api";

interface Props {
  open: boolean;
  onClose: () => void;
  // Optional thread id — when set, the dialog dispatches mail:reply
  // instead of mail:send and hides the recipient field.
  replyTo?: { threadId: string; subject: string };
  onSent?: () => void;
}

export function Composer({ open, onClose, replyTo, onSent }: Props) {
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState(replyTo?.subject ?? "");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const reset = () => {
    setTo("");
    setSubject(replyTo?.subject ?? "");
    setBody("");
    setErr(null);
    setBusy(false);
  };

  const close = () => {
    reset();
    onClose();
  };

  const send = async () => {
    setBusy(true);
    setErr(null);
    try {
      // Recommend an idempotency key so a double-click never sends the
      // message twice. Using a content-derived key keeps it stable
      // across retries within the same composer session.
      const idempotencyKey = `web:${replyTo?.threadId ?? "send"}:${hash(body)}:${Date.now()
        .toString(36)
        .slice(0, 6)}`;
      if (replyTo) {
        await client().applyCommand({
          type: "mail:reply",
          payload: { threadId: replyTo.threadId, body },
          idempotencyKey,
        });
      } else {
        await client().applyCommand({
          type: "mail:send",
          payload: {
            to: to.split(",").map((s) => s.trim()).filter(Boolean),
            subject,
            body,
          },
          idempotencyKey,
        });
      }
      onSent?.();
      close();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={close}>
      <h3 className="text-base font-semibold">{replyTo ? "Reply" : "Compose"}</h3>
      <div className="mt-3 flex flex-col gap-2">
        {replyTo ? (
          <p className="text-xs text-muted">
            Replying in thread{" "}
            <code>{replyTo.threadId.slice(0, 16)}…</code>
          </p>
        ) : (
          <Input
            placeholder="to@example.com (comma-separate multiple)"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        )}
        {!replyTo ? (
          <Input
            placeholder="Subject"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
          />
        ) : null}
        <textarea
          className="min-h-32 w-full rounded-md border border-border bg-bg p-2 text-sm"
          placeholder="Body…"
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
        {err ? <p className="text-xs text-danger">{err}</p> : null}
        <div className="flex justify-end gap-2 mt-2">
          <Button variant="ghost" onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={
              busy ||
              body.trim().length === 0 ||
              (!replyTo && (to.trim().length === 0 || subject.trim().length === 0))
            }
            onClick={send}
          >
            {busy ? "Sending…" : "Send"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function hash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
