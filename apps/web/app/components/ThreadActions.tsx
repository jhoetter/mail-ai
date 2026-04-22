// Snooze / Mark done / Reopen quick actions, used inside the thread
// header. Calls the per-user thread-state command surface so two
// people in a shared inbox don't trip over each other's "done".

import { Check, Clock, RotateCcw } from "lucide-react";
import { useState } from "react";
import { Button } from "@mailai/ui";
import { useTranslator } from "../lib/i18n/useTranslator";
import { dispatchCommand } from "../lib/commands-client";

interface Props {
  providerThreadId: string;
  status?: "open" | "snoozed" | "done";
  onChanged?: () => void;
}

const SNOOZE_OPTIONS: ReadonlyArray<{ key: string; until: string }> = [
  { key: "today", until: "today" },
  { key: "tomorrow", until: "tomorrow" },
  { key: "weekend", until: "weekend" },
  { key: "next-week", until: "next-week" },
];

export function ThreadActions({ providerThreadId, status = "open", onChanged }: Props) {
  const { t } = useTranslator();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const dispatch = async (type: string, payload: Record<string, unknown>) => {
    setBusy(true);
    try {
      await dispatchCommand({ type: type as Parameters<typeof dispatchCommand>[0]["type"], payload });
      onChanged?.();
    } catch (err) {
      console.warn(type, err);
    } finally {
      setBusy(false);
      setOpen(false);
    }
  };

  return (
    <div className="flex items-center gap-1">
      {status === "open" || status === "snoozed" ? (
        <div className="relative">
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() => setOpen((v) => !v)}
          >
            <span className="inline-flex items-center gap-1.5">
              <Clock size={14} aria-hidden />
              {t("thread.tags.snooze")}
            </span>
          </Button>
          {open ? (
            <div className="absolute right-0 top-full z-10 mt-1 w-44 rounded-md border border-divider bg-surface shadow-lg">
              {SNOOZE_OPTIONS.map((opt) => (
                <button
                  key={opt.key}
                  type="button"
                  className="flex w-full items-center justify-between px-3 py-1.5 text-left text-xs text-foreground hover:bg-background/60"
                  onClick={() =>
                    void dispatch("thread:snooze", { providerThreadId, until: opt.until })
                  }
                >
                  <span>{opt.key}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      {status === "open" ? (
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => void dispatch("thread:mark-done", { providerThreadId })}
        >
          <span className="inline-flex items-center gap-1.5">
            <Check size={14} aria-hidden />
            {t("thread.tags.markDone")}
          </span>
        </Button>
      ) : (
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => void dispatch("thread:reopen", { providerThreadId })}
        >
          <span className="inline-flex items-center gap-1.5">
            <RotateCcw size={14} aria-hidden />
            {t("thread.tags.reopen")}
          </span>
        </Button>
      )}
    </div>
  );
}
