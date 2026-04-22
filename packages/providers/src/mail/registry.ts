// MailProviderRegistry is the single switch on `account.provider`
// that the rest of the codebase is allowed to do.
//
// Server handlers ask the registry for the adapter, then issue
// port methods. Adding a new provider becomes one place to wire
// (`register()`) instead of N if/else branches scattered across
// handlers, routes, and the calendar/contacts surfaces.

import { MailaiError } from "@mailai/core";
import type { MailProviderId } from "../types.js";
import type { MailProvider } from "./port.js";

export class MailProviderRegistry {
  private readonly adapters = new Map<MailProviderId, MailProvider>();

  register(adapter: MailProvider): void {
    if (this.adapters.has(adapter.id)) {
      throw new MailaiError(
        "validation_error",
        `mail provider ${adapter.id} already registered`,
      );
    }
    this.adapters.set(adapter.id, adapter);
  }

  // Lookup with an exhaustive `never` switch on the provider union.
  // Adding a new MailProviderId variant becomes a TypeScript error
  // here until we extend the switch — that's the entire point.
  for(provider: MailProviderId): MailProvider {
    switch (provider) {
      case "google-mail":
      case "outlook": {
        const adapter = this.adapters.get(provider);
        if (!adapter) {
          throw new MailaiError(
            "validation_error",
            `no mail adapter registered for provider ${provider}`,
          );
        }
        return adapter;
      }
      default: {
        // Forces a compile-time error if MailProviderId grows but
        // this switch doesn't.
        const _exhaustive: never = provider;
        throw new MailaiError(
          "validation_error",
          `unhandled mail provider ${String(_exhaustive)}`,
        );
      }
    }
  }

  has(provider: MailProviderId): boolean {
    return this.adapters.has(provider);
  }

  list(): ReadonlyArray<MailProvider> {
    return [...this.adapters.values()];
  }
}
