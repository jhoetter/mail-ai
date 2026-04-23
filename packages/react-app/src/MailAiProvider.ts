// MailAiProvider — public alias of {@link AppProviders}.
//
// Phase A of the headless composable embed introduces named exports
// the host (hof-os) can import à la carte instead of swallowing the
// monolithic `MailAiApp`. To make the new surface area read like a
// single product family, the provider is re-exported under the
// `MailAi*` prefix even though `AppProviders` stays around for
// backward compatibility (the standalone `apps/web/src/main.tsx`
// composes it manually and expects the historical name).

export { AppProviders as MailAiProvider } from "./AppProviders.js";
export type { AppProvidersProps as MailAiProviderProps } from "./AppProviders.js";
