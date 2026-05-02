import { HOF_SHELL_APP_LINKS, type HofShellAppId, type HofShellAppLink } from "@hofos/shell-ui";

const DATA_APP_LOCAL_ORIGIN = "http://localhost:3000";
const SUBAPP_HOST_PREFIXES = new Set(["mail", "mailai", "chat", "collabai", "drive", "driveai", "pages", "pagesai", "hofos"]);

type HandoffAppLinksOptions = {
  selfAppId?: HofShellAppId;
  selfHref?: string;
};

const SUBAPP_LINK_OVERRIDES: Partial<Record<HofShellAppId, string>> = {
  mailai: "/__subapps/mailai/inbox",
  collabai: "/__subapps/collabai/",
  driveai: "/__subapps/driveai/drive/home",
  pagesai: "/__subapps/pagesai/pages",
  hofos: "/__subapps/hofos/customers",
};

export function createHandoffAppLinks(options: HandoffAppLinksOptions = {}): HofShellAppLink[] {
  return HOF_SHELL_APP_LINKS.map((link) => {
    const href =
      options.selfAppId === link.id && options.selfHref
        ? options.selfHref
        : SUBAPP_LINK_OVERRIDES[link.id] ?? link.href;
    return { ...link, href };
  });
}

export function navigateHandoffHref(href: string): void {
  window.location.href = href.startsWith("/__subapps/") ? `${dataAppOrigin()}${href}` : href;
}

function dataAppOrigin(): string {
  const { protocol, hostname, port, origin } = window.location;
  if (hostname === "localhost" || hostname === "127.0.0.1") {
    return port === "3000" ? origin : DATA_APP_LOCAL_ORIGIN;
  }
  const labels = hostname.split(".").filter(Boolean);
  if (labels.length > 2 && SUBAPP_HOST_PREFIXES.has(labels[0] ?? "")) {
    return `${protocol}//${labels.slice(1).join(".")}`;
  }
  return origin;
}
