// MailAiSettingsNav — headless extraction of the SETTINGS section
// from `apps/web/app/components/AppNav.tsx`. Renders the Accounts /
// Tags / Inboxes / Audit list.
//
// Same composability contract as `MailAiViewNav`: router-free, the
// host owns navigation. Pass `activePath` to highlight the matching
// row; `onNavigate(href)` fires when the user picks a row.

import { Mailbox, ScrollText, Tag, User, type LucideIcon } from "lucide-react";

import { NavRow } from "./MailAiViewNav.js";

interface SettingsItem {
  readonly href: string;
  readonly label: string;
  readonly icon: LucideIcon;
}

// We bake the labels in English here intentionally: the embedded
// host (hof-os) owns its own translator chain and it would be
// confusing for the embed to translate against mail-ai's i18n
// catalogue when the rest of hof-os' chrome is German. Hosts that
// want translation can wrap this component with their own labels by
// composing `NavRow` directly — `MailAiSettingsNav` is the convenience
// default.
const SETTINGS_ITEMS: readonly SettingsItem[] = [
  { href: "/settings/account", label: "Accounts", icon: User },
  { href: "/settings/tags", label: "Tags", icon: Tag },
  { href: "/settings/inboxes", label: "Inboxes", icon: Mailbox },
  { href: "/settings/audit", label: "Audit log", icon: ScrollText },
];

export interface MailAiSettingsNavProps {
  /**
   * Currently displayed mail-ai path (e.g. `/settings/account`).
   * Used to highlight the matching row. Optional — defaults to no
   * active row.
   */
  readonly activePath?: string;
  /** Fired when the user picks a row. The host owns navigation. */
  readonly onNavigate?: (path: string) => void;
}

export function MailAiSettingsNav({ activePath, onNavigate }: MailAiSettingsNavProps) {
  const pathname = (activePath ?? "").split("?")[0] ?? "";
  return (
    <div className="flex flex-col gap-0.5">
      {SETTINGS_ITEMS.map((item) => (
        <NavRow
          key={item.href}
          href={item.href}
          label={item.label}
          icon={item.icon}
          active={pathname === item.href || pathname.startsWith(item.href + "/")}
          onNavigate={onNavigate}
        />
      ))}
    </div>
  );
}
