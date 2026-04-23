// mailaiCommands — pure factory returning the seed of mail-ai
// command-palette items the host can merge into its own ⌘K index.
//
// Phase A scope: navigation + a single "compose" action. Per-page
// dynamic commands (Reply, Forward, Star, Snooze) are still owned
// by Inbox / ThreadView via `useRegisterPaletteCommands` and will
// be exposed through a future `MailAiCommandsBridge` once the host
// has a stable command-bus contract. For now the seed is enough to
// let the host's palette deep-link into mail-ai surfaces.

import type { CommandPaletteItem } from "../contract.js";

export interface MailAiCommandContext {
  /**
   * Currently active mail-ai pseudo-route inside the host shell
   * (e.g. `/inbox`, `/calendar`). Optional — used only to score /
   * suppress redundant "Go to current page" entries.
   */
  readonly route?: string;
  /**
   * Currently selected entity, if any. Hosts pass through whatever
   * mirror state they keep (e.g. selected thread id from
   * `MailAiInbox`'s `onNavigate`). Loose-typed on purpose so the
   * contract survives Phase B additions without breaking hosts.
   */
  readonly selected?: Readonly<Record<string, unknown>>;
  /**
   * Navigator the commands invoke when picked. Hosts typically
   * pass their router's `navigate` here, optionally wrapped to
   * mirror the path into the embedded `MailAi*` pane.
   */
  navigate?(path: string): void;
}

interface SeedItem {
  readonly id: string;
  readonly group: string;
  readonly label: string;
  readonly shortcut?: string;
  /** Pathname this item navigates to. Used both for `perform` and for
   * the "current page" suppression. */
  readonly path: string;
}

const SEED: readonly SeedItem[] = [
  { id: "mailai.go-inbox", group: "Mail", label: "Go to Inbox", shortcut: "g i", path: "/inbox" },
  { id: "mailai.go-drafts", group: "Mail", label: "Go to Drafts", path: "/drafts" },
  { id: "mailai.go-sent", group: "Mail", label: "Go to Sent", path: "/inbox?view=sent" },
  {
    id: "mailai.go-snoozed",
    group: "Mail",
    label: "Go to Snoozed",
    path: "/inbox?view=snoozed",
  },
  { id: "mailai.go-trash", group: "Mail", label: "Go to Trash", path: "/inbox?view=trash" },
  {
    id: "mailai.compose",
    group: "Mail",
    label: "Compose new mail",
    shortcut: "c",
    path: "/drafts?new=1",
  },
  {
    id: "mailai.go-calendar",
    group: "Calendar",
    label: "Go to Calendar",
    shortcut: "g c",
    path: "/calendar",
  },
  { id: "mailai.go-accounts", group: "Settings", label: "Mail accounts", path: "/settings/account" },
  { id: "mailai.go-tags", group: "Settings", label: "Tags", path: "/settings/tags" },
  { id: "mailai.go-inboxes", group: "Settings", label: "Inboxes", path: "/settings/inboxes" },
  { id: "mailai.go-audit", group: "Settings", label: "Audit log", path: "/settings/audit" },
];

export function mailaiCommands(ctx: MailAiCommandContext = {}): readonly CommandPaletteItem[] {
  const navigate = ctx.navigate;
  const currentPath = ctx.route ? (ctx.route.split("?")[0] ?? "") : "";

  return SEED.flatMap((seed): CommandPaletteItem[] => {
    const seedPath = seed.path.split("?")[0] ?? "";
    // Suppress "Go to <current page>" so the palette doesn't offer
    // a no-op navigation for the surface the user is already on.
    if (currentPath && currentPath === seedPath && !seed.path.includes("?")) {
      return [];
    }
    const item: CommandPaletteItem = {
      id: seed.id,
      group: seed.group,
      label: seed.label,
      perform() {
        if (navigate) navigate(seed.path);
        else if (typeof window !== "undefined") window.location.assign(seed.path);
      },
    };
    if (seed.shortcut) {
      return [{ ...item, shortcut: seed.shortcut }];
    }
    return [item];
  });
}
