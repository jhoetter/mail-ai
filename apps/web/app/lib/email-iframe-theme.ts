import {
  fallbackEmailIframeThemeSnapshot,
  type EmailIframeThemeSnapshot,
} from "./email-html";

/**
 * Snapshots semantic colors from the host document for the sanitized email
 * iframe. The iframe `srcdoc` cannot inherit app CSS variables, so we read
 * computed custom properties once per render cycle.
 */
export function readEmailIframeThemeSnapshot(root: HTMLElement | null): EmailIframeThemeSnapshot {
  if (!root || typeof window === "undefined") {
    return fallbackEmailIframeThemeSnapshot();
  }
  const fb = fallbackEmailIframeThemeSnapshot();
  const cs = getComputedStyle(root);

  function pick(prop: keyof EmailIframeThemeSnapshot, varName: string): string {
    const raw = cs.getPropertyValue(varName).trim();
    return raw.length > 0 ? raw : fb[prop];
  }

  return {
    foreground: pick("foreground", "--foreground"),
    accent: pick("accent", "--accent"),
    secondary: pick("secondary", "--secondary"),
    divider: pick("divider", "--divider"),
    readerPaper: pick("readerPaper", "--mailai-reader-paper"),
    readerInk: pick("readerInk", "--mailai-reader-ink"),
  };
}
