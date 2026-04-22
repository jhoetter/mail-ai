// Tiny global toast that listens on the command-errors channel and
// surfaces a "couldn't save" banner whenever a dispatched command
// comes back with mutation.status === "failed". Without this the
// only signal a user gets is the optimistic UI rolling back, which
// looks like the button itself is broken (the original "starring is
// dead" complaint was actually missing OAuth credentials on the
// server — invisible to the user).
//
// Stacks at most one toast at a time and auto-dismisses after a few
// seconds. Click the X to dismiss earlier. Auth errors render a
// distinct "reconnect" surface that points the user at the accounts
// page (where the per-account lastSyncError reveals the underlying
// cause) and stays visible longer because the user has to act on it.

import { AlertTriangle, X } from "lucide-react";
import { useEffect, useState } from "react";
import { subscribeCommandErrors, type CommandError } from "../lib/command-errors";
import { useTranslator } from "../lib/i18n/useTranslator";

const DEFAULT_TIMEOUT_MS = 5000;
const STICKY_TIMEOUT_MS = 12000;
const ACCOUNTS_HREF = "/settings/account";

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

  const command = prettyCommand(err.commandType);
  const isAuth = err.code === "auth_error";

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 justify-center px-4"
    >
      <div className="pointer-events-auto flex max-w-md items-start gap-3 rounded-lg border border-divider bg-surface px-3 py-2 text-sm shadow-lg">
        <AlertTriangle size={16} aria-hidden className="mt-0.5 shrink-0 text-warning" />
        <div className="min-w-0 flex-1">
          {isAuth ? (
            <>
              <p className="font-medium text-foreground">{t("toast.authTitle")}</p>
              <p className="mt-0.5 text-xs text-secondary">
                {t("toast.authBody", { command })}
              </p>
              <p className="mt-1 break-words text-[11px] text-tertiary">
                {t("toast.authDetails", { message: err.message })}
              </p>
              <a
                href={ACCOUNTS_HREF}
                className="mt-2 inline-flex h-7 items-center rounded-md bg-accent px-2.5 text-xs font-medium text-background hover:opacity-90"
                onClick={() => setErr(null)}
              >
                {t("toast.authCta")}
              </a>
            </>
          ) : (
            <>
              <p className="font-medium text-foreground">
                {t("toast.commandFailed", { command })}
              </p>
              <p className="mt-0.5 break-words text-xs text-secondary">{err.message}</p>
            </>
          )}
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
