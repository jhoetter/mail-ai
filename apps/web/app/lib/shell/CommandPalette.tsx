import { CommandPalette as HofCommandPalette, type CommandItem } from "@hofos/ux";
import { useMemo } from "react";
import { useTranslator } from "../i18n/useTranslator";
import { usePaletteRegistry } from "./paletteRegistry";

export function CommandPalette() {
  const reg = usePaletteRegistry();
  const { t } = useTranslator();

  const commands = useMemo<CommandItem[]>(
    () =>
      reg.list().map((cmd) => ({
        id: cmd.id,
        label: cmd.label,
        group: cmd.section ?? "Other",
        disabled: cmd.enabled === false,
        keywords: [cmd.label, cmd.hint ?? "", cmd.section ?? ""],
        ...(cmd.hint ? { hint: cmd.hint } : {}),
        ...(cmd.shortcut ? { shortcut: cmd.shortcut } : {}),
        ...(cmd.enabled === false || !cmd.run ? {} : { perform: cmd.run }),
      })),
    [reg],
  );

  return (
    <HofCommandPalette
      open={reg.isOpen}
      onOpenChange={(open) => (open ? reg.open() : reg.close())}
      commands={commands}
      placeholder={t("palette.placeholder")}
      emptyLabel={t("palette.empty")}
    />
  );
}
