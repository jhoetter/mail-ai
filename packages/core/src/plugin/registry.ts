// Plugin registry. A plugin registers command handlers + reactor
// callbacks. Each layer (collaboration, imap-sync, agent) ships as a
// plugin so adding a feature is a single registration point and the
// command bus stays free of cross-cutting imports.

import type { CommandBus } from "../command/bus.js";

export interface MailaiPlugin {
  readonly name: string;
  readonly description?: string;
  register(bus: CommandBus): void | Promise<void>;
}

export class PluginRegistry {
  private readonly plugins = new Map<string, MailaiPlugin>();
  add(plugin: MailaiPlugin) {
    if (this.plugins.has(plugin.name)) {
      throw new Error(`duplicate plugin: ${plugin.name}`);
    }
    this.plugins.set(plugin.name, plugin);
  }
  list(): readonly MailaiPlugin[] {
    return Array.from(this.plugins.values());
  }
  async installAll(bus: CommandBus) {
    for (const p of this.plugins.values()) await p.register(bus);
  }
}
