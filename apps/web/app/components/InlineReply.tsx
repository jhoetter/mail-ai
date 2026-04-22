"use client";

// In-thread reply pane. Anchored to the bottom of ThreadView the same
// way Gmail / Front does — never a modal, because replying to mail is
// not a side trip away from the conversation, it IS the conversation.
//
// Two visual states:
//   1. Collapsed → a single-row "Reply / Reply all / Forward" bar.
//      Cheap, doesn't fight the reading layout.
//   2. Expanded  → recipient row + subject/quote header + RichEditor +
//      Send/Discard. Stays inside the reader scroll context.
//
// We dispatch `mail:reply` (with bodyText + bodyHtml so the recipient
// gets a multipart message) and let the parent re-fetch the thread on
// success so the user sees their reply land.

import { Button, RichEditor, type RichEditorChange, type RichEditorHandle } from "@mailai/ui";
import { Forward, Reply, ReplyAll, Send, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { client } from "../lib/api";
import { useTranslator } from "../lib/i18n/useTranslator";
import type { ThreadDetail, ThreadMessage } from "../lib/threads-client";

interface Props {
  readonly thread: ThreadDetail;
  readonly onSent: () => void;
  /**
   * Auto-expand on mount. Used by the keyboard shortcut "r" so the
   * editor is ready as soon as the user hits the key.
   */
  readonly autoExpand?: boolean;
  readonly autoExpandKey?: number;
}

export function InlineReply({ thread, onSent, autoExpand, autoExpandKey }: Props) {
  const { t } = useTranslator();
  const [expanded, setExpanded] = useState(!!autoExpand);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const valueRef = useRef<RichEditorChange>({ html: "", text: "" });
  const editorRef = useRef<RichEditorHandle | null>(null);

  // Expand on demand from a parent shortcut (palette "r"). The key
  // bumps every time so re-pressing focuses the editor again.
  useEffect(() => {
    if (autoExpandKey === undefined) return;
    setExpanded(true);
    // Defer so the contenteditable mounts first.
    queueMicrotask(() => editorRef.current?.focus());
  }, [autoExpandKey]);

  const root = thread.messages[thread.messages.length - 1];
  const replyToName = root?.fromName ?? root?.fromEmail ?? root?.from ?? "";

  const onChange = useCallback((v: RichEditorChange) => {
    valueRef.current = v;
  }, []);

  const send = useCallback(async () => {
    const { html, text } = valueRef.current;
    if (text.trim().length === 0) return;
    setBusy(true);
    setErr(null);
    try {
      const idempotencyKey = `web:reply:${thread.id}:${hash(text)}:${Date.now()
        .toString(36)
        .slice(0, 6)}`;
      await client().applyCommand({
        type: "mail:reply",
        payload: {
          threadId: thread.id,
          body: text,
          ...(html.trim().length > 0 ? { bodyHtml: html } : {}),
        },
        idempotencyKey,
      });
      editorRef.current?.setContent("");
      valueRef.current = { html: "", text: "" };
      setExpanded(false);
      onSent();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [onSent, thread.id]);

  if (!expanded) {
    return (
      <div className="sticky bottom-0 z-10 -mx-4 mt-4 border-t border-divider bg-background/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className="flex items-center gap-2">
          <Button variant="primary" size="sm" onClick={() => setExpanded(true)}>
            <span className="inline-flex items-center gap-1.5">
              <Reply size={14} aria-hidden />
              {t("thread.reply")}
            </span>
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setExpanded(true)}>
            <span className="inline-flex items-center gap-1.5">
              <ReplyAll size={14} aria-hidden />
              {t("thread.replyAll")}
            </span>
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setExpanded(true)}>
            <span className="inline-flex items-center gap-1.5">
              <Forward size={14} aria-hidden />
              {t("thread.forward")}
            </span>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="sticky bottom-0 z-10 -mx-4 mt-4 border-t border-divider bg-background/95 px-4 pt-3 pb-4 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <div className="overflow-hidden rounded-lg border border-divider bg-surface shadow-sm">
        <div className="flex items-center justify-between gap-2 border-b border-divider px-3 py-2">
          <div className="min-w-0 truncate text-xs text-secondary">
            {t("thread.replyPlaceholder", { name: replyToName }).replace("…", "")}
          </div>
          <div className="flex shrink-0 items-center gap-2 text-[11px] text-tertiary">
            <kbd className="rounded border border-divider bg-background px-1.5 py-0.5 font-mono text-[10px] text-secondary">
              {t("thread.replyHint")}
            </kbd>
          </div>
        </div>
        <RichEditor
          ref={editorRef}
          ariaLabel={t("composer.body")}
          placeholder={t("thread.replyPlaceholder", { name: replyToName })}
          minHeight={160}
          maxHeight={340}
          onChange={onChange}
          onSubmit={() => void send()}
        />
        {err ? (
          <p className="border-t border-divider bg-error-bg/40 px-3 py-2 text-xs text-error-text">
            {t("composer.sendError", { error: err })}
          </p>
        ) : null}
        <div className="flex items-center justify-between border-t border-divider px-3 py-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              editorRef.current?.setContent("");
              valueRef.current = { html: "", text: "" };
              setExpanded(false);
              setErr(null);
            }}
            disabled={busy}
          >
            <span className="inline-flex items-center gap-1.5">
              <Trash2 size={14} aria-hidden />
              {t("thread.discard")}
            </span>
          </Button>
          <Button variant="primary" size="sm" onClick={() => void send()} disabled={busy}>
            <span className="inline-flex items-center gap-1.5">
              <Send size={14} aria-hidden />
              {busy ? t("composer.sending") : t("composer.send")}
            </span>
          </Button>
        </div>
      </div>
    </div>
  );
}

// Borrow the same hash from Composer so idempotency keys collide for
// double-submits but not for distinct messages.
function hash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// Re-export so future thread-related callers can also key shortcut
// hookups by the latest message in the chain (Reply-all targets etc).
export type { ThreadMessage };
