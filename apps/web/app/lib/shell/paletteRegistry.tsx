import { createScopedCommandRegistry } from "@hofos/ux";
import type { PaletteCommand, PaletteRegistry } from "./types";

const registry = createScopedCommandRegistry<PaletteCommand>(
  "usePaletteRegistry: AppShell missing in tree",
);

export const PaletteRegistryProvider = registry.ScopedCommandRegistryProvider;
export const useRegisterPaletteCommands = registry.useRegisterScopedCommands;

export function usePaletteRegistry(): PaletteRegistry {
  return registry.useScopedCommandRegistry();
}
