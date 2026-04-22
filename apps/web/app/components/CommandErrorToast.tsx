// Tiny global toast that listens on the command-errors channel and
// surfaces a "couldn't save" banner whenever a dispatched command
// comes back with mutation.status === "failed". Without this the
// only signal a user gets is the optimistic UI rolling back, which
// looks like the button itself is broken (the original "starring is
// dead" complaint was actually missing OAuth credentials on the
// server — invisible to the user).
//
// Stacks at most one toast at a time and auto-dismisses after a few
// seconds. Click the X to dismiss earlier. Auth errors stay visible
// longer because the user usually has to act on them.

import { AlertTriangle, X } from "lucide-react";
import { useEffect, useState } from "react";
import { subscribeCommandErrors, type CommandError } from "../lib/command-errors";
import { useTranslator } from "../lib/i18n/useTranslator";

const DEFAULT_TIMEOUT_MS = 5000;
const STICKY_TIMEOUT_MS = 9000;

export function CommandErrorToast() {
  const { t } = useTranslator();
  const [err, setErr] = useState<CommandError | null>(null);

  useEffect(() => {
    return subscribeCommandErrors((next) => setErr(next));
  }, []);

  useEffect(() => {
    if (!err) return;
    const timeout = err.code === "auth_error" ? STICKY_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
    const handle = setTimeout(() => setErr(null), timeout);
    return () => clearTimeout(handle);
  }, [err]);

  if (!err) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 justify-center px-4"
    >
      <div className="pointer-events-auto flex max-w-md items-start gap-3 rounded-lg border border-divider bg-surface px-3 py-2 text-sm shadow-lg">
        <AlertTriangle size={16} aria-hidden className="mt-0.5 shrink-0 text-warning" />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-foreground">
            {t("toast.commandFailed", { command: prettyCommand(err.commandType) })}
          </p>
          <p className="mt-0.5 break-words text-xs text-secondary">{err.message}</p>
        </div>
        <button
          type="button"
          aria-label={t("common.close")}
          onClick={() => setErr(null)}
          className="shrink-0 rounded p-1 text-tertiary hover:bg-hover hover:text-foreground"
        >
          <X size={14} aria-hidden />
        </button>
      </div>
    </div>
  );
}

function prettyCommand(type: string): string {
  // "thread:add-tag" → "thread add tag". Avoids exposing the bus
  // transport label verbatim while still letting the user spot which
  // surface failed.
  return type.replace(/[:_-]/g, " ");
}
