"use client";

// In-app replacements for `window.alert`, `window.confirm`, and
// `window.prompt`. The native browser dialogs look out of place in a
// designed product (different fonts, no theming, focus-stealing on
// macOS) and they're impossible to test with our component harness.
//
// Usage:
//
//   const dialogs = useDialogs();
//   const ok = await dialogs.confirm({
//     title: "Discard draft?",
//     description: "This can't be undone.",
//     tone: "danger",
//   });
//
// Mount `<DialogsProvider>` once near the application root. Calls
// from outside a provider throw — we want loud failures, not silent
// fall-back to native dialogs that we are explicitly trying to kill.

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Button } from "../primitives/button";
import { Dialog } from "../primitives/dialog";
import { Input } from "../primitives/input";

type Tone = "default" | "danger";

export interface ConfirmOptions {
  readonly title: string;
  readonly description?: ReactNode;
  readonly confirmLabel?: string;
  readonly cancelLabel?: string;
  readonly tone?: Tone;
}

export interface AlertOptions {
  readonly title: string;
  readonly description?: ReactNode;
  readonly okLabel?: string;
  readonly tone?: Tone;
}

export interface PromptOptions {
  readonly title: string;
  readonly description?: ReactNode;
  readonly placeholder?: string;
  readonly defaultValue?: string;
  readonly okLabel?: string;
  readonly cancelLabel?: string;
  readonly inputType?: "text" | "url" | "email";
}

export interface DialogsApi {
  confirm(opts: ConfirmOptions): Promise<boolean>;
  alert(opts: AlertOptions): Promise<void>;
  prompt(opts: PromptOptions): Promise<string | null>;
}

interface ConfirmEntry {
  readonly kind: "confirm";
  readonly id: number;
  readonly opts: ConfirmOptions;
  readonly resolve: (value: boolean) => void;
}
interface AlertEntry {
  readonly kind: "alert";
  readonly id: number;
  readonly opts: AlertOptions;
  readonly resolve: () => void;
}
interface PromptEntry {
  readonly kind: "prompt";
  readonly id: number;
  readonly opts: PromptOptions;
  readonly resolve: (value: string | null) => void;
}
type Entry = ConfirmEntry | AlertEntry | PromptEntry;

const DialogsContext = createContext<DialogsApi | null>(null);

export function useDialogs(): DialogsApi {
  const ctx = useContext(DialogsContext);
  if (!ctx) {
    throw new Error(
      "useDialogs() requires <DialogsProvider> to be mounted higher in the tree.",
    );
  }
  return ctx;
}

export interface DialogsProviderProps {
  readonly children: ReactNode;
}

export function DialogsProvider({ children }: DialogsProviderProps) {
  // FIFO queue. Multiple awaiters get served in arrival order so
  // nothing is ever silently dropped.
  const [queue, setQueue] = useState<readonly Entry[]>([]);
  const idRef = useRef(0);
  const nextId = useCallback(() => {
    idRef.current += 1;
    return idRef.current;
  }, []);

  const api = useMemo<DialogsApi>(
    () => ({
      confirm(opts) {
        return new Promise<boolean>((resolve) => {
          setQueue((q) => [...q, { kind: "confirm", id: nextId(), opts, resolve }]);
        });
      },
      alert(opts) {
        return new Promise<void>((resolve) => {
          setQueue((q) => [...q, { kind: "alert", id: nextId(), opts, resolve }]);
        });
      },
      prompt(opts) {
        return new Promise<string | null>((resolve) => {
          setQueue((q) => [...q, { kind: "prompt", id: nextId(), opts, resolve }]);
        });
      },
    }),
    [nextId],
  );

  const dismissHead = useCallback(() => {
    setQueue((q) => q.slice(1));
  }, []);

  const head = queue[0];

  return (
    <DialogsContext.Provider value={api}>
      {children}
      {head ? <ActiveDialog entry={head} onDone={dismissHead} /> : null}
    </DialogsContext.Provider>
  );
}

interface ActiveDialogProps {
  readonly entry: Entry;
  readonly onDone: () => void;
}

function ActiveDialog({ entry, onDone }: ActiveDialogProps) {
  switch (entry.kind) {
    case "confirm":
      return (
        <ConfirmBody
          opts={entry.opts}
          onResult={(v) => {
            entry.resolve(v);
            onDone();
          }}
        />
      );
    case "alert":
      return (
        <AlertBody
          opts={entry.opts}
          onResult={() => {
            entry.resolve();
            onDone();
          }}
        />
      );
    case "prompt":
      return (
        <PromptBody
          opts={entry.opts}
          onResult={(v) => {
            entry.resolve(v);
            onDone();
          }}
        />
      );
    default: {
      const _exhaustive: never = entry;
      void _exhaustive;
      return null;
    }
  }
}

function ConfirmBody({
  opts,
  onResult,
}: {
  opts: ConfirmOptions;
  onResult: (v: boolean) => void;
}) {
  return (
    <Dialog open onClose={() => onResult(false)} fullScreenOnMobile={false}>
      <DialogHeader title={opts.title} description={opts.description} />
      <Footer>
        <Button variant="secondary" size="sm" onClick={() => onResult(false)}>
          {opts.cancelLabel ?? "Cancel"}
        </Button>
        <Button
          autoFocus
          variant={opts.tone === "danger" ? "danger" : "primary"}
          size="sm"
          onClick={() => onResult(true)}
        >
          {opts.confirmLabel ?? "OK"}
        </Button>
      </Footer>
    </Dialog>
  );
}

function AlertBody({
  opts,
  onResult,
}: {
  opts: AlertOptions;
  onResult: () => void;
}) {
  return (
    <Dialog open onClose={() => onResult()} fullScreenOnMobile={false}>
      <DialogHeader title={opts.title} description={opts.description} />
      <Footer>
        <Button
          autoFocus
          variant={opts.tone === "danger" ? "danger" : "primary"}
          size="sm"
          onClick={() => onResult()}
        >
          {opts.okLabel ?? "OK"}
        </Button>
      </Footer>
    </Dialog>
  );
}

function PromptBody({
  opts,
  onResult,
}: {
  opts: PromptOptions;
  onResult: (v: string | null) => void;
}) {
  const [value, setValue] = useState(opts.defaultValue ?? "");
  const submit = () => onResult(value);
  return (
    <Dialog open onClose={() => onResult(null)} fullScreenOnMobile={false}>
      <DialogHeader title={opts.title} description={opts.description} />
      <div className="mt-4">
        <Input
          autoFocus
          type={opts.inputType ?? "text"}
          value={value}
          placeholder={opts.placeholder}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
        />
      </div>
      <Footer>
        <Button variant="secondary" size="sm" onClick={() => onResult(null)}>
          {opts.cancelLabel ?? "Cancel"}
        </Button>
        <Button variant="primary" size="sm" onClick={submit}>
          {opts.okLabel ?? "OK"}
        </Button>
      </Footer>
    </Dialog>
  );
}

function DialogHeader({
  title,
  description,
}: {
  title: string;
  description?: ReactNode;
}) {
  return (
    <header>
      <h2 className="text-base font-semibold">{title}</h2>
      {description !== undefined && description !== null && description !== "" ? (
        <div className="mt-1 text-sm text-secondary">{description}</div>
      ) : null}
    </header>
  );
}

function Footer({ children }: { children: ReactNode }) {
  return <div className="mt-5 flex justify-end gap-2">{children}</div>;
}
