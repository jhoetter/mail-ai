// Single-source attachment viewer for the @mailai/react-app embed.
// Routes PDFs and Office files (docx/xlsx/pptx) into the
// @officeai/react-editors components so the same renderer is used in
// hof-os' /edit-asset, mail-ai standalone, and collaboration-ai chat
// attachments. For unsupported MIME types it falls back to a plain
// download link.
//
// @officeai/react-editors is an OPTIONAL peer dep — when the
// postinstall (`scripts/ensure-officeai-react-editors.cjs`) cannot
// fetch it (offline / lockfile placeholder) we render a graceful
// "download" affordance instead of crashing the whole embed.

import { lazy, Suspense } from "react";

const PdfEditor = lazy(async () => {
  try {
    const mod = await import("@officeai/react-editors/components/pdf");
    return { default: mod.PdfEditor };
  } catch {
    return { default: () => null };
  }
});

const DocxEditor = lazy(async () => {
  try {
    const mod = await import("@officeai/react-editors/components/docx");
    return { default: mod.DocxEditor };
  } catch {
    return { default: () => null };
  }
});

const XlsxEditor = lazy(async () => {
  try {
    const mod = await import("@officeai/react-editors/components/xlsx");
    return { default: mod.XlsxEditor };
  } catch {
    return { default: () => null };
  }
});

const PptxEditor = lazy(async () => {
  try {
    const mod = await import("@officeai/react-editors/components/pptx");
    return { default: mod.PptxEditor };
  } catch {
    return { default: () => null };
  }
});

export type AttachmentKind = "pdf" | "docx" | "xlsx" | "pptx" | "other";

export function attachmentKindFor(mime: string, filename?: string): AttachmentKind {
  const ext = (filename ?? "").toLowerCase().split(".").pop() ?? "";
  if (mime === "application/pdf" || ext === "pdf") return "pdf";
  if (
    mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    ext === "docx"
  )
    return "docx";
  if (
    mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    ext === "xlsx"
  )
    return "xlsx";
  if (
    mime === "application/vnd.openxmlformats-officedocument.presentationml.presentation" ||
    ext === "pptx"
  )
    return "pptx";
  return "other";
}

export interface AttachmentViewerProps {
  readonly url: string;
  readonly mime: string;
  readonly filename: string;
  readonly readOnly?: boolean;
}

export function AttachmentViewer(props: AttachmentViewerProps) {
  const kind = attachmentKindFor(props.mime, props.filename);
  const fallback = (
    <a
      href={props.url}
      target="_blank"
      rel="noreferrer"
      download={props.filename}
      className="text-accent underline"
    >
      {props.filename}
    </a>
  );
  return (
    <Suspense fallback={null}>
      {kind === "pdf" && <PdfEditor url={props.url} readOnly={props.readOnly ?? true} />}
      {kind === "docx" && <DocxEditor url={props.url} readOnly={props.readOnly ?? true} />}
      {kind === "xlsx" && <XlsxEditor url={props.url} readOnly={props.readOnly ?? true} />}
      {kind === "pptx" && <PptxEditor url={props.url} readOnly={props.readOnly ?? true} />}
      {kind === "other" && fallback}
    </Suspense>
  );
}
