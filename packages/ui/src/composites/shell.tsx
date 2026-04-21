import type { ReactNode } from "react";

interface Props {
  sidebar: ReactNode;
  children: ReactNode;
}

export function Shell({ sidebar, children }: Props) {
  return (
    <div className="grid h-screen grid-cols-[240px_1fr] bg-bg text-fg">
      <aside className="border-r border-border bg-surface p-4">{sidebar}</aside>
      <main className="overflow-y-auto p-6">{children}</main>
    </div>
  );
}
