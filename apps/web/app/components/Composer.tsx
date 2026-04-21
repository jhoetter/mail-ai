"use client";

import { Button, Dialog, Input } from "@mailai/ui";
import { useState } from "react";

interface Props {
  open: boolean;
  onClose: () => void;
  onSend?: (draft: { to: string; subject: string; body: string }) => Promise<void> | void;
}

export function Composer({ open, onClose, onSend }: Props) {
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");

  return (
    <Dialog open={open} onClose={onClose}>
      <h3 className="text-base font-semibold">Compose</h3>
      <div className="mt-3 flex flex-col gap-2">
        <Input placeholder="to@example.com" value={to} onChange={(e) => setTo(e.target.value)} />
        <Input placeholder="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
        <textarea
          className="min-h-32 w-full rounded-md border border-border bg-bg p-2 text-sm"
          placeholder="Body…"
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
        <div className="flex justify-end gap-2 mt-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={async () => {
              if (onSend) await onSend({ to, subject, body });
              onClose();
            }}
          >
            Send
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
