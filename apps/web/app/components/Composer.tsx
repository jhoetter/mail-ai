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
import { useAttachmentUploads } from "../lib/attachment-uploads";
import { AttachmentTray } from "./AttachmentTray";
import { RecipientField } from "./RecipientField";

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
  const [to, setTo] = useState<string[]>(initialDraft?.to ?? []);
  const [showCcBcc, setShowCcBcc] = useState(false);
  const [cc, setCc] = useState<string[]>(initialDraft?.cc ?? []);
  const [bcc, setBcc] = useState<string[]>(initialDraft?.bcc ?? []);
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
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const uploads = useAttachmentUploads({ draftId });

  const reset = useCallback(() => {
    setTo(initialDraft?.to ?? []);
    setCc(initialDraft?.cc ?? []);
    setBcc(initialDraft?.bcc ?? []);
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
    if (!text && !subject && to.length === 0) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const recipients = to;
      const ccList = cc;
      const bccList = bcc;
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
      const attachmentRefs = uploads.refs;
      if (replyTo) {
        await client().applyCommand({
          type: "mail:reply",
          payload: {
            threadId: replyTo.threadId,
            body: text,
            ...(html ? { bodyHtml: html } : {}),
            ...(attachmentRefs.length > 0 ? { attachments: attachmentRefs } : {}),
          },
          idempotencyKey,
        });
      } else if (draftId) {
        await dispatchCommand({ type: "draft:send", payload: { id: draftId } });
      } else {
        await client().applyCommand({
          type: "mail:send",
          payload: {
            to,
            ...(cc.length > 0 ? { cc } : {}),
            ...(bcc.length > 0 ? { bcc } : {}),
            subject,
            body: text,
            ...(html ? { bodyHtml: html } : {}),
            ...(attachmentRefs.length > 0 ? { attachments: attachmentRefs } : {}),
            ...(draftId ? { draftId } : {}),
          },
          idempotencyKey,
        });
      }
      onSent?.();
      uploads.reset();
      close();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }, [bcc, cc, close, draftId, onSent, replyTo, subject, to, uploads]);

  const onPickFiles = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const onFileInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      if (files.length > 0) void uploads.addFiles(files);
      e.target.value = "";
    },
    [uploads],
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const files = Array.from(e.dataTransfer.files ?? []);
      if (files.length > 0) void uploads.addFiles(files);
    },
    [uploads],
  );

  const onPaste = useCallback(
    (e: React.ClipboardEvent) => {
      const files: File[] = [];
      for (const item of Array.from(e.clipboardData.items)) {
        if (item.kind === "file") {
          const f = item.getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length > 0) void uploads.addFiles(files);
    },
    [uploads],
  );

  if (!open) return null;

  // Layout per mode. We use fixed positioning so the panel floats over
  // the app shell without forcing the inbox to recompute its grid.
  //
  // Mobile (< sm): the floating panel chrome doesn't make sense on a
  // 360px-wide phone — the user can barely read the form, let alone
  // see the inbox behind it. Below `sm` we promote every mode to a
  // true full-screen sheet using dynamic viewport units (so iOS
  // Safari's URL bar doesn't crop the bottom of the editor). The
  // header bar still has a Close button so the user can dismiss.
  //
  // Desktop (≥ sm): the original Gmail-style three-mode floating
  // panel anchored to the bottom-right is preserved.
  const mobileClass =
    "fixed inset-0 z-40 flex h-[100dvh] w-screen flex-col rounded-none border-0 bg-background shadow-none";
  const panelClass =
    mode === "full"
      ? `${mobileClass} sm:inset-8 sm:h-auto sm:w-auto sm:rounded-xl sm:border sm:border-divider sm:shadow-2xl`
      : mode === "normal"
        ? `${mobileClass} sm:inset-auto sm:bottom-0 sm:right-4 sm:left-auto sm:top-auto sm:h-[640px] sm:max-h-[calc(100vh-2rem)] sm:w-[560px] sm:max-w-[calc(100vw-2rem)] sm:overflow-hidden sm:rounded-t-xl sm:border sm:border-b-0 sm:border-divider sm:shadow-2xl`
        : `${mobileClass} sm:inset-auto sm:bottom-0 sm:right-4 sm:left-auto sm:top-auto sm:h-auto sm:w-[420px] sm:max-w-[calc(100vw-2rem)] sm:rounded-t-xl sm:border sm:border-b-0 sm:border-divider sm:shadow-xl`;

  return (
    <div
      className={panelClass}
      role="dialog"
      aria-label={replyTo ? t("composer.replyTitle") : t("composer.newMessage")}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
      onPaste={onPaste}
    >
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={onFileInputChange}
      />
      {dragOver ? (
        <div
          className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-xl border-2 border-dashed border-foreground/40 bg-background/80 text-sm text-foreground"
          aria-hidden
        >
          {t("composer.dropFilesHere")}
        </div>
      ) : null}
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
                  <RecipientField
                    value={to}
                    onChange={setTo}
                    placeholder={t("composer.to")}
                    ariaLabel={t("composer.to")}
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
                      <RecipientField
                        value={cc}
                        onChange={setCc}
                        placeholder={t("composer.cc")}
                        ariaLabel={t("composer.cc")}
                      />
                    </FieldRow>
                    <FieldRow label={t("composer.bcc")}>
                      <RecipientField
                        value={bcc}
                        onChange={setBcc}
                        placeholder={t("composer.bcc")}
                        ariaLabel={t("composer.bcc")}
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

          {/* Attachments */}
          <AttachmentTray
            slots={uploads.slots}
            onRemove={uploads.remove}
            onPick={onPickFiles}
          />

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
                  (!replyTo && (to.length === 0 || subject.trim().length === 0))
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
