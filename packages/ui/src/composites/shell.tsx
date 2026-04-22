import type { ReactNode } from "react";

interface Props {
  sidebar: ReactNode;
  children: ReactNode;
}

export function Shell({ sidebar, children }: Props) {
  return (
    <div className="grid h-screen grid-cols-[240px_1fr] bg-background text-foreground">
      <aside className="border-r border-divider bg-surface p-4">{sidebar}</aside>
      {/* `flex flex-col` (not just `overflow-y-auto`) so child pages
          can opt into a full-height, dual-pane layout by adding
          `min-h-0 flex-1` to the section that should fill the
          remaining space (Inbox, Calendar). Pages that don't use
          that escape hatch still scroll naturally. */}
      <main className="flex min-h-0 flex-col overflow-y-auto p-6">{children}</main>
    </div>
  );
}
