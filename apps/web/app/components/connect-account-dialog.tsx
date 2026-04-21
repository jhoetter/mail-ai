"use client";

// Connect-account dialog. Two big provider buttons (Gmail, Outlook),
// a state-machine driven body that explains every stage of the flow,
// and a graceful demo-mode panel that points at docs/oauth-setup.md
// when the API doesn't have NANGO_SECRET_KEY set.

import { Button, Dialog } from "@mailai/ui";
import { useNangoConnect } from "../lib/use-nango-connect";
import type { ConnectStage } from "../lib/use-nango-connect";
import type { AccountSummary, ConnectProvider } from "../lib/oauth-client";

export interface ConnectAccountDialogProps {
  open: boolean;
  onClose: () => void;
  onConnected?: (acc: AccountSummary) => void;
}

export function ConnectAccountDialog({
  open,
  onClose,
  onConnected,
}: ConnectAccountDialogProps) {
  const { stage, connect, reset } = useNangoConnect({
    ...(onConnected ? { onConnected } : {}),
  });

  const close = () => {
    reset();
    onClose();
  };

  // Computed up here so the buttons render in the picker block below
  // without TS narrowing `stage.kind` away from in-flight values.
  const inFlight = stage.kind === "starting" || stage.kind === "awaiting-user";
  const showPicker =
    stage.kind === "idle" || stage.kind === "error" || stage.kind === "success";

  return (
    <Dialog open={open} onClose={close}>
      <div className="space-y-4">
        <header>
          <h2 className="text-lg font-semibold">Connect a mail account</h2>
          <p className="mt-1 text-sm text-muted">
            mail-ai connects to Gmail and Outlook over OAuth via{" "}
            <a
              className="underline"
              href="https://docs.nango.dev/integrations/all/google-mail"
              target="_blank"
              rel="noreferrer"
            >
              Nango
            </a>{" "}
            for the initial handshake. After that, we own the tokens — refreshes
            go straight to Google/Microsoft.
          </p>
        </header>

        <StageBody stage={stage} />

        {showPicker && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <ProviderButton
              provider="google-mail"
              label="Connect Gmail"
              brand="#EA4335"
              onClick={() => connect("google-mail")}
              disabled={inFlight}
            />
            <ProviderButton
              provider="outlook"
              label="Connect Outlook"
              brand="#0078D4"
              onClick={() => connect("outlook")}
              disabled={inFlight}
            />
          </div>
        )}

        <footer className="flex justify-end gap-2 pt-2">
          {stage.kind === "success" ? (
            <Button variant="primary" size="sm" onClick={close}>
              Done
            </Button>
          ) : (
            <Button variant="ghost" size="sm" onClick={close}>
              {stage.kind === "awaiting-user" ? "Cancel" : "Close"}
            </Button>
          )}
        </footer>
      </div>
    </Dialog>
  );
}

function ProviderButton({
  provider,
  label,
  brand,
  onClick,
  disabled,
}: {
  provider: ConnectProvider;
  label: string;
  brand: string;
  onClick: () => void;
  disabled: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex items-center justify-center gap-3 rounded-lg border border-border bg-surface px-4 py-3 text-sm font-medium hover:bg-bg disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      data-provider={provider}
    >
      <span
        aria-hidden
        className="inline-block h-5 w-5 rounded-full"
        style={{ background: brand }}
      />
      {label}
    </button>
  );
}

function StageBody({ stage }: { stage: ConnectStage }) {
  switch (stage.kind) {
    case "idle":
      return null;
    case "starting":
      return (
        <Notice tone="info">
          Requesting a Nango Connect session for{" "}
          <strong>{providerLabel(stage.provider)}</strong>…
        </Notice>
      );
    case "awaiting-user":
      return (
        <Notice tone="info">
          A secure popup is open. Sign in with{" "}
          <strong>{providerLabel(stage.provider)}</strong> and approve the
          mail-ai access. We&apos;ll detect when you finish.
        </Notice>
      );
    case "finalizing":
      return (
        <Notice tone="info">
          Almost there — fetching your tokens and storing the connection…
        </Notice>
      );
    case "success":
      return (
        <Notice tone="success">
          Connected <strong>{stage.account.email}</strong> via{" "}
          <strong>{providerLabel(stage.provider)}</strong>. mail-ai will refresh
          tokens automatically from now on.
        </Notice>
      );
    case "error":
      if (stage.code === "nango_not_configured") {
        return (
          <Notice tone="warn">
            <p>
              <strong>Demo mode:</strong> the API server is running without{" "}
              <code className="font-mono">NANGO_SECRET_KEY</code>, so OAuth
              popups can&apos;t be opened.
            </p>
            <p className="mt-2">
              Two-minute fix:{" "}
              <a
                className="underline"
                href="https://github.com/jhoetter/mail-ai/blob/main/docs/oauth-setup.md"
                target="_blank"
                rel="noreferrer"
              >
                docs/oauth-setup.md
              </a>{" "}
              — sign up at{" "}
              <a
                className="underline"
                href="https://app.nango.dev"
                target="_blank"
                rel="noreferrer"
              >
                app.nango.dev
              </a>
              , copy the secret key, restart with{" "}
              <code className="font-mono">NANGO_SECRET_KEY=… make dev</code>.
            </p>
          </Notice>
        );
      }
      return (
        <Notice tone="error">
          <p>
            <strong>Connection failed.</strong>{" "}
            {stage.code ? <code className="font-mono">{stage.code}</code> : null}
          </p>
          <p className="mt-1 text-xs">{stage.message}</p>
        </Notice>
      );
    default: {
      const _exhaustive: never = stage;
      void _exhaustive;
      return null;
    }
  }
}

type NoticeTone = "info" | "success" | "warn" | "error";

const NOTICE_PALETTE: Record<NoticeTone, string> = {
  info: "border-border bg-surface text-fg",
  success: "border-success/40 bg-success/10 text-fg",
  warn: "border-yellow-500/40 bg-yellow-500/10 text-fg",
  error: "border-danger/40 bg-danger/10 text-fg",
};

function Notice({
  tone,
  children,
}: {
  tone: NoticeTone;
  children: React.ReactNode;
}) {
  return (
    <div className={`rounded-md border px-3 py-2 text-sm ${NOTICE_PALETTE[tone]}`}>
      {children}
    </div>
  );
}

function providerLabel(p: ConnectProvider): string {
  return p === "google-mail" ? "Gmail" : "Outlook";
}
