"use client";

import { Button } from "@mailai/ui";

interface Props {
  threadId: string;
  subject: string;
}

export function ThreadView({ threadId, subject }: Props) {
  return (
    <div>
      <h2 className="text-base font-semibold">{subject}</h2>
      <p className="text-xs text-muted mt-1">{threadId}</p>
      <div className="mt-4 prose text-sm text-fg">
        <p>
          (Thread rendering, internal comments, assignment + status controls live here. Wired
          to the command bus via the HTTP API in Phase 5 build.)
        </p>
      </div>
      <div className="mt-4 flex gap-2">
        <Button size="sm" variant="primary">Reply</Button>
        <Button size="sm" variant="secondary">Assign</Button>
        <Button size="sm" variant="secondary">Resolve</Button>
      </div>
    </div>
  );
}
