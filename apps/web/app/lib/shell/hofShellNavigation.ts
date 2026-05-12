import { useEffect, useMemo, useState } from "react";
import {
  HOF_SHELL_APP_LINKS,
  createHofShellAppLinksFromRegistry,
  resolveDataAppOrigin,
  type HofShellAppId,
  type HofShellAppLink,
  type HofShellSubappRegistryEntry,
} from "@hofos/shell-ui";

type HandoffAppLinksOptions = {
  selfAppId?: HofShellAppId;
  selfHref?: string;
};

export function createHandoffAppLinks(options: HandoffAppLinksOptions = {}): HofShellAppLink[] {
  return withSelfHref(HOF_SHELL_APP_LINKS, options);
}

export function useHandoffAppLinks(options: HandoffAppLinksOptions = {}): HofShellAppLink[] {
  const { selfAppId, selfHref } = options;
  const selfOptions = useMemo(
    (): HandoffAppLinksOptions => ({
      ...(selfAppId ? { selfAppId } : {}),
      ...(selfHref ? { selfHref } : {}),
    }),
    [selfAppId, selfHref],
  );
  const fallbackLinks = useMemo(
    () => createHandoffAppLinks(selfOptions),
    [selfOptions],
  );
  const [links, setLinks] = useState<HofShellAppLink[]>(fallbackLinks);

  useEffect(() => {
    let alive = true;
    setLinks(fallbackLinks);
    void fetchConfiguredAppLinks()
      .then((configured) => {
        if (alive) setLinks(withSelfHref(configured, selfOptions));
      })
      .catch(() => {
        if (alive) setLinks(fallbackLinks);
      });
    return () => {
      alive = false;
    };
  }, [fallbackLinks, selfOptions]);

  return links;
}

export function navigateHandoffHref(href: string): void {
  window.location.href = href.startsWith("/__subapps/") ? `${resolveDataAppOrigin()}${href}` : href;
}

function withSelfHref(links: readonly HofShellAppLink[], options: HandoffAppLinksOptions): HofShellAppLink[] {
  return links.map((link) =>
    options.selfAppId === link.id && options.selfHref ? { ...link, href: options.selfHref } : link,
  );
}

function readStoredHofToken(): string | null {
  try {
    return window.localStorage.getItem("hof_token") || window.sessionStorage.getItem("hof_token");
  } catch {
    return null;
  }
}

async function fetchConfiguredAppLinks(): Promise<HofShellAppLink[]> {
  const dataAppOrigin = resolveDataAppOrigin();
  const token = readStoredHofToken();
  const response = await fetch(`${dataAppOrigin}/api/functions/list_attached_subapps`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: "{}",
  });
  if (!response.ok) throw new Error(`list_attached_subapps HTTP ${response.status}`);
  const payload = (await response.json().catch(() => null)) as
    | { result?: HofShellSubappRegistryEntry[] }
    | HofShellSubappRegistryEntry[]
    | null;
  const entries = Array.isArray(payload) ? payload : (payload?.result ?? []);
  return createHofShellAppLinksFromRegistry(Array.isArray(entries) ? entries : [], {
    appHref: `${dataAppOrigin}/`,
  });
}
