export { AppShell, type AppShellChrome } from "./AppShell";
export { ChromeProvider, useChrome } from "./ChromeContext";
export { CommandPalette } from "./CommandPalette";
export {
  PaletteRegistryProvider,
  usePaletteRegistry,
  useRegisterPaletteCommands,
} from "./paletteRegistry";
export type { PaletteCommand, PaletteRegistry, CommandRun } from "./types";
