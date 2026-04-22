// CalendarProviderRegistry — same single-switch pattern as the mail
// + push registries. Server boot registers concrete adapters; the
// calendar handler asks for an adapter keyed on
// `account.provider` and never branches on the provider id.

import { MailaiError } from "@mailai/core";
import type { MailProviderId } from "../types.js";
import type { CalendarProvider } from "./port.js";

export class CalendarProviderRegistry {
  private readonly adapters = new Map<MailProviderId, CalendarProvider>();

  register(adapter: CalendarProvider): void {
    if (this.adapters.has(adapter.id)) {
      throw new MailaiError(
        "validation_error",
        `calendar provider ${adapter.id} already registered`,
      );
    }
    this.adapters.set(adapter.id, adapter);
  }

  for(provider: MailProviderId): CalendarProvider | null {
    switch (provider) {
      case "google-mail":
      case "outlook":
        return this.adapters.get(provider) ?? null;
      default: {
        const _exhaustive: never = provider;
        throw new MailaiError(
          "validation_error",
          `unhandled calendar provider ${String(_exhaustive)}`,
        );
      }
    }
  }

  has(provider: MailProviderId): boolean {
    return this.adapters.has(provider);
  }

  list(): ReadonlyArray<CalendarProvider> {
    return [...this.adapters.values()];
  }
}
