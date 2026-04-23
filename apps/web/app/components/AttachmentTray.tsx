// Renders the row of staged attachments that live below the composer
// editor (and inside InlineReply). Each chip shows the file name +
// formatted size, an upload progress bar while the PUT is in flight,
// and an X to remove. The actual upload state machine lives in the
// `useAttachmentUploads` hook so Composer + InlineReply can both reuse
// it with one line of glue.

import { File, FileImage, FileText, Paperclip, X } from "lucide-react";
import { useTranslator } from "../lib/i18n/useTranslator";
import type { AttachmentSlot } from "../lib/attachment-uploads";

interface Props {
  readonly slots: readonly AttachmentSlot[];
  readonly onRemove: (slotId: string) => void;
  readonly onPick: () => void;
  readonly compact?: boolean;
}

export function AttachmentTray({ slots, onRemove, onPick, compact }: Props) {
  const { t } = useTranslator();
  if (slots.length === 0 && compact) return null;

  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-divider px-3 py-2">
      <button
        type="button"
        onClick={onPick}
        className="inline-flex items-center gap-1.5 rounded border border-divider px-2 py-1 text-xs text-secondary hover:bg-foreground/5 hover:text-foreground"
        title={t("composer.attach")}
        aria-label={t("composer.attach")}
      >
        <Paperclip size={14} aria-hidden />
        {t("composer.attach")}
      </button>
      {slots.map((slot) => (
        <Chip key={slot.id} slot={slot} onRemove={onRemove} />
      ))}
    </div>
  );
}

interface ChipProps {
  readonly slot: AttachmentSlot;
  readonly onRemove: (slotId: string) => void;
}

function Chip({ slot, onRemove }: ChipProps) {
  const { t } = useTranslator();
  const Icon = iconFor(slot.mime);
  const isUploading = slot.status === "uploading";
  const isFailed = slot.status === "failed";

  return (
    <div
      className={[
        "group inline-flex max-w-[18rem] items-center gap-2 rounded border px-2 py-1 text-xs",
        isFailed
          ? "border-error/60 bg-error-bg/40 text-error-text"
          : "border-divider bg-foreground/5 text-foreground",
      ].join(" ")}
      title={slot.filename}
    >
      <Icon size={14} aria-hidden className="shrink-0" />
      <span className="truncate">{slot.filename}</span>
      <span className="shrink-0 text-[10px] text-tertiary">{formatSize(slot.sizeBytes)}</span>
      {isUploading ? (
        <span className="shrink-0 text-[10px] text-secondary">{t("composer.uploading")}</span>
      ) : null}
      {isFailed ? <span className="shrink-0 text-[10px]">{t("composer.uploadFailed")}</span> : null}
      <button
        type="button"
        onClick={() => onRemove(slot.id)}
        title={t("composer.attachmentRemove")}
        aria-label={t("composer.attachmentRemove")}
        className="ml-1 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-tertiary hover:bg-foreground/10 hover:text-foreground"
      >
        <X size={12} aria-hidden />
      </button>
    </div>
  );
}

function iconFor(mime: string) {
  if (mime.startsWith("image/")) return FileImage;
  if (mime.startsWith("text/") || mime === "application/pdf") return FileText;
  return File;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
