// PushProviderRegistry — same single-switch pattern as
// MailProviderRegistry. Server boot registers concrete adapters;
// the scheduler asks the registry for the right one keyed on
// `account.provider` and never branches on the provider id itself.

import { MailaiError } from "@mailai/core";
import type { MailProviderId } from "../types.js";
import type { PushProvider } from "./port.js";

export class PushProviderRegistry {
  private readonly adapters = new Map<MailProviderId, PushProvider>();

  register(adapter: PushProvider): void {
    if (this.adapters.has(adapter.id)) {
      throw new MailaiError("validation_error", `push provider ${adapter.id} already registered`);
    }
    this.adapters.set(adapter.id, adapter);
  }

  // Lookup with an exhaustive `never` switch on the provider union
  // so adding a new MailProviderId variant becomes a TypeScript
  // error here until we extend the switch.
  for(provider: MailProviderId): PushProvider | null {
    switch (provider) {
      case "google-mail":
      case "outlook":
        return this.adapters.get(provider) ?? null;
      default: {
        const _exhaustive: never = provider;
        throw new MailaiError("validation_error", `unhandled push provider ${String(_exhaustive)}`);
      }
    }
  }

  has(provider: MailProviderId): boolean {
    return this.adapters.has(provider);
  }

  list(): ReadonlyArray<PushProvider> {
    return [...this.adapters.values()];
  }
}
