// Lightweight i18n types. Cloned in spirit from office-ai's
// implementation so the two projects stay copy-paste compatible
// for hooks like useTranslator and the LocaleToggle component.
//
// We intentionally don't depend on next-intl: every page in this
// app is client-rendered, the catalogues are tiny (a few KB each),
// and a tiny zero-dep helper keeps the i18n surface trivial to
// reason about. If we ever need ICU plural / select rules we'll
// graduate the offending keys to `intl-messageformat` per-key.
export type Locale = "en" | "de";

export const SUPPORTED_LOCALES: ReadonlyArray<Locale> = ["en", "de"] as const;
export const DEFAULT_LOCALE: Locale = "en";

// Cookie name lives in the mail-ai namespace so a shared host with
// office-ai (e.g. an internal multi-tenant deployment) doesn't have
// the two products fight over the same key.
export const LOCALE_COOKIE = "mailai.locale";

// `string` may contain `{name}` ICU-style placeholders which
// `t(key, vars)` substitutes at format time.
export type MessageNode = string | { readonly [key: string]: MessageNode };
export type Messages = Readonly<Record<string, MessageNode>>;

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && SUPPORTED_LOCALES.includes(value as Locale);
}
