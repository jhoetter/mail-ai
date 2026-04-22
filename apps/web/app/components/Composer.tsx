"use client";

// Composer for **new** messages. Reply lives inline inside the
// thread (see InlineReply). For new mail we use a Gmail-style
// floating panel anchored to the bottom-right of the viewport,
// with three sizes:
//
//   • minimized → header bar only (so a half-written draft never
//     disappears when the user clicks back to the inbox).
//   • normal    → ~560×640 floating window, standard composing.
//   • full      → near-full-screen overlay for long messages.
//
// The editor is the same `RichEditor` the inline reply uses, so the
// formatting toolbar, paste-cleanup, and HTML/text dual emit are
// shared by both surfaces.
//
// Drafts are autosaved through the existing `draft:create` /
// `draft:update` commands; that part is unchanged from the old
// dialog Composer — only the chrome around it is new.

import { Button, RichEditor, type RichEditorChange, type RichEditorHandle } from "@mailai/ui";
import {
  ChevronUp,
  Maximize2,
  Minimize2,
  Minus,
  Trash2,
  X as CloseIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { client } from "../lib/api";
import { useTranslator } from "../lib/i18n/useTranslator";
import { dispatchCommand } from "../lib/commands-client";
import type { DraftSummary } from "../lib/drafts-client";

type Mode = "min" | "normal" | "full";

interface Props {
  open: boolean;
  onClose: () => void;
  // Optional thread id — when set, the panel dispatches mail:reply
  // instead of mail:send and hides the recipient field. (In the
  // normal flow ThreadView's InlineReply handles replies, so this
  // is only used when something else opens a reply via Composer —
  // e.g. a future "reply from search results" affordance.)
  replyTo?: { threadId: string; subject: string };
  onSent?: () => void;
  // Resume editing an existing overlay-only draft. The draft id is
  // passed back into draft:* commands so we don't accidentally fork.
  draftId?: string;
  initialDraft?: DraftSummary;
}

export function Composer({
  open,
  onClose,
  replyTo,
  onSent,
  draftId: initialDraftId,
  initialDraft,
}: Props) {
  const { t } = useTranslator();
  const [mode, setMode] = useState<Mode>("normal");
  const [to, setTo] = useState(initialDraft?.to.join(", ") ?? "");
  const [showCcBcc, setShowCcBcc] = useState(false);
  const [cc, setCc] = useState(initialDraft?.cc?.join(", ") ?? "");
  const [bcc, setBcc] = useState(initialDraft?.bcc?.join(", ") ?? "");
  const [subject, setSubject] = useState(
    initialDraft?.subject ?? replyTo?.subject ?? "",
  );
  const valueRef = useRef<RichEditorChange>({
    html: initialDraft?.bodyHtml ?? "",
    text: initialDraft?.bodyText ?? "",
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [draftId, setDraftId] = useState<string | null>(initialDraftId ?? null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editorRef = useRef<RichEditorHandle | null>(null);

  const reset = useCallback(() => {
    setTo(initialDraft?.to.join(", ") ?? "");
    setCc(initialDraft?.cc?.join(", ") ?? "");
    setBcc(initialDraft?.bcc?.join(", ") ?? "");
    setSubject(initialDraft?.subject ?? replyTo?.subject ?? "");
    valueRef.current = {
      html: initialDraft?.bodyHtml ?? "",
      text: initialDraft?.bodyText ?? "",
    };
    editorRef.current?.setContent(initialDraft?.bodyHtml ?? "");
    setErr(null);
    setBusy(false);
  }, [initialDraft, replyTo]);

  // Debounced draft autosave. We deliberately only autosave when
  // there's *something* to save and we're not in the middle of
  // sending — otherwise we'd race the send/delete cycle. The body
  // lives in a ref (the contenteditable owns its own value), so
  // we bump `bodyTick` from `onEditorChange` to retrigger the save.
  const [bodyTick, setBodyTick] = useState(0);
  useEffect(() => {
    if (!open || busy) return;
    if (replyTo) return; // replies don't autosave as drafts (yet)
    const text = valueRef.current.text;
    const html = valueRef.current.html;
    if (!text && !subject && !to) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const recipients = to.split(",").map((s) => s.trim()).filter(Boolean);
      const ccList = cc.split(",").map((s) => s.trim()).filter(Boolean);
      const bccList = bcc.split(",").map((s) => s.trim()).filter(Boolean);
      if (draftId) {
        void dispatchCommand({
          type: "draft:update",
          payload: {
            id: draftId,
            to: recipients,
            ...(ccList.length > 0 ? { cc: ccList } : {}),
            ...(bccList.length > 0 ? { bcc: bccList } : {}),
            subject,
            bodyText: text,
            ...(html ? { bodyHtml: html } : {}),
          },
        }).then(() => setSavedAt(Date.now()));
      } else {
        void dispatchCommand({
          type: "draft:create",
          payload: {
            to: recipients,
            ...(ccList.length > 0 ? { cc: ccList } : {}),
            ...(bccList.length > 0 ? { bcc: bccList } : {}),
            subject,
            bodyText: text,
            ...(html ? { bodyHtml: html } : {}),
          },
        })
          .then((res) => {
            const created = res.after.find((s) => s.kind === "draft");
            if (created) setDraftId(created.id);
            setSavedAt(Date.now());
          })
          .catch(() => undefined);
      }
    }, 1200);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [to, cc, bcc, subject, open, busy, replyTo, draftId, bodyTick]);

  const onEditorChange = useCallback((v: RichEditorChange) => {
    valueRef.current = v;
    setBodyTick((n) => n + 1);
  }, []);

  const close = useCallback(() => {
    reset();
    onClose();
  }, [onClose, reset]);

  const send = useCallback(async () => {
    setBusy(true);
    setErr(null);
    const { html, text } = valueRef.current;
    try {
      const idempotencyKey = `web:${replyTo?.threadId ?? draftId ?? "send"}:${hash(text)}:${Date.now()
        .toString(36)
        .slice(0, 6)}`;
      if (replyTo) {
        await client().applyCommand({
          type: "mail:reply",
          payload: {
            threadId: replyTo.threadId,
            body: text,
            ...(html ? { bodyHtml: html } : {}),
          },
          idempotencyKey,
        });
      } else if (draftId) {
        await dispatchCommand({ type: "draft:send", payload: { id: draftId } });
      } else {
        const ccList = cc.split(",").map((s) => s.trim()).filter(Boolean);
        const bccList = bcc.split(",").map((s) => s.trim()).filter(Boolean);
        await client().applyCommand({
          type: "mail:send",
          payload: {
            to: to.split(",").map((s) => s.trim()).filter(Boolean),
            ...(ccList.length > 0 ? { cc: ccList } : {}),
            ...(bccList.length > 0 ? { bcc: bccList } : {}),
            subject,
            body: text,
            ...(html ? { bodyHtml: html } : {}),
          },
          idempotencyKey,
        });
      }
      onSent?.();
      close();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }, [bcc, cc, close, draftId, onSent, replyTo, subject, to]);

  if (!open) return null;

  // Layout per mode. We use fixed positioning so the panel floats over
  // the app shell without forcing the inbox to recompute its grid.
  const panelClass =
    mode === "full"
      ? "fixed inset-4 sm:inset-8 z-40 flex flex-col rounded-xl border border-divider bg-background shadow-2xl"
      : mode === "normal"
        ? "fixed bottom-0 right-4 z-40 flex h-[640px] max-h-[calc(100vh-2rem)] w-[560px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-t-xl border border-b-0 border-divider bg-background shadow-2xl"
        : "fixed bottom-0 right-4 z-40 flex w-[420px] max-w-[calc(100vw-2rem)] flex-col rounded-t-xl border border-b-0 border-divider bg-background shadow-xl";

  return (
    <div className={panelClass} role="dialog" aria-label={replyTo ? t("composer.replyTitle") : t("composer.newMessage")}>
      {/* Title bar */}
      <div
        className="flex items-center justify-between gap-2 border-b border-divider bg-foreground px-3 py-2 text-background"
        onDoubleClick={() => setMode((m) => (m === "min" ? "normal" : "min"))}
      >
        <div className="min-w-0 truncate text-xs font-medium">
          {subject || (replyTo ? t("composer.replyTitle") : t("composer.newMessage"))}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <IconBtn
            label={mode === "min" ? t("composer.expand") : t("composer.minimize")}
            onClick={() => setMode((m) => (m === "min" ? "normal" : "min"))}
          >
            {mode === "min" ? <ChevronUp size={14} aria-hidden /> : <Minus size={14} aria-hidden />}
          </IconBtn>
          <IconBtn
            label={mode === "full" ? t("composer.collapse") : t("composer.maximize")}
            onClick={() => setMode((m) => (m === "full" ? "normal" : "full"))}
          >
            {mode === "full" ? (
              <Minimize2 size={14} aria-hidden />
            ) : (
              <Maximize2 size={14} aria-hidden />
            )}
          </IconBtn>
          <IconBtn label={t("common.close")} onClick={close}>
            <CloseIcon size={14} aria-hidden />
          </IconBtn>
        </div>
      </div>

      {mode === "min" ? null : (
        <>
          {/* Header fields */}
          <div className="flex flex-col border-b border-divider">
            {!replyTo ? (
              <>
                <FieldRow label={t("composer.to")}>
                  <input
                    className="w-full bg-transparent px-1 text-sm text-foreground outline-none placeholder:text-tertiary"
                    placeholder={t("composer.to")}
                    value={to}
                    onChange={(e) => setTo(e.target.value)}
                  />
                  <button
                    type="button"
                    onClick={() => setShowCcBcc((v) => !v)}
                    className="ml-2 shrink-0 text-xs text-secondary hover:text-foreground"
                  >
                    {t("composer.showCcBcc")}
                  </button>
                </FieldRow>
                {showCcBcc ? (
                  <>
                    <FieldRow label={t("composer.cc")}>
                      <input
                        className="w-full bg-transparent px-1 text-sm text-foreground outline-none placeholder:text-tertiary"
                        placeholder={t("composer.cc")}
                        value={cc}
                        onChange={(e) => setCc(e.target.value)}
                      />
                    </FieldRow>
                    <FieldRow label={t("composer.bcc")}>
                      <input
                        className="w-full bg-transparent px-1 text-sm text-foreground outline-none placeholder:text-tertiary"
                        placeholder={t("composer.bcc")}
                        value={bcc}
                        onChange={(e) => setBcc(e.target.value)}
                      />
                    </FieldRow>
                  </>
                ) : null}
                <FieldRow label={t("composer.subject")}>
                  <input
                    className="w-full bg-transparent px-1 text-sm text-foreground outline-none placeholder:text-tertiary"
                    placeholder={t("composer.subject")}
                    value={subject}
                    onChange={(e) => setSubject(e.target.value)}
                  />
                </FieldRow>
              </>
            ) : (
              <FieldRow label={t("thread.to")}>
                <span className="px-1 text-xs text-secondary">
                  <code>{replyTo.threadId.slice(0, 16)}…</code>
                </span>
              </FieldRow>
            )}
          </div>

          {/* Editor */}
          <div className="flex flex-1 min-h-0 flex-col">
            <RichEditor
              ref={editorRef}
              ariaLabel={t("composer.body")}
              defaultValue={initialDraft?.bodyHtml ?? ""}
              placeholder={t("composer.bodyPlaceholder")}
              minHeight="100%"
              maxHeight={mode === "full" ? "100%" : "100%"}
              className="h-full"
              onChange={onEditorChange}
              onSubmit={() => void send()}
            />
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between gap-2 border-t border-divider px-3 py-2">
            <div className="flex items-center gap-2">
              <Button
                variant="primary"
                size="sm"
                onClick={() => void send()}
                disabled={
                  busy ||
                  valueRef.current.text.trim().length === 0 ||
                  (!replyTo && (to.trim().length === 0 || subject.trim().length === 0))
                }
              >
                {busy ? t("composer.sending") : t("composer.send")}
              </Button>
              {savedAt ? (
                <span className="text-[10px] text-tertiary">{t("draftsClient.saved")}</span>
              ) : null}
            </div>
            <div className="flex items-center gap-2">
              {err ? (
                <span className="truncate text-xs text-error" title={err}>
                  {t("composer.sendError", { error: err })}
                </span>
              ) : null}
              <IconBtn label={t("composer.discard")} onClick={close}>
                <Trash2 size={14} aria-hidden />
              </IconBtn>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

interface FieldRowProps {
  readonly label: string;
  readonly children: React.ReactNode;
}

function FieldRow({ label, children }: FieldRowProps) {
  return (
    <div className="flex items-center gap-2 border-b border-divider px-3 py-1.5 last:border-b-0">
      <span className="w-12 shrink-0 text-xs uppercase tracking-wide text-tertiary">
        {label}
      </span>
      <div className="flex min-w-0 flex-1 items-center">{children}</div>
    </div>
  );
}

interface IconBtnProps {
  readonly label: string;
  readonly onClick: () => void;
  readonly children: React.ReactNode;
}

function IconBtn({ label, onClick, children }: IconBtnProps) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="inline-flex h-6 w-6 items-center justify-center rounded text-background/80 hover:bg-background/15 hover:text-background"
    >
      {children}
    </button>
  );
}

function hash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
