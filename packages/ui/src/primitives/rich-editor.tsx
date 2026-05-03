"use client";

// RichEditor: Tiptap (ProseMirror) surface with toolbar parity vs the old
// contenteditable implementation: bold/italic/underline, lists, quote, code,
// link, tables, and inline images. Plain `@name` mentions can be typed as text;
// full mention chips can be wired later with the Mention extension + picker.

import {
  Bold,
  Code as CodeIcon,
  Eraser,
  Image as ImageIcon,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  Quote,
  Table as TableIcon,
  Underline,
} from "lucide-react";
import Image from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import Table from "@tiptap/extension-table";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";
import TableRow from "@tiptap/extension-table-row";
import UnderlineExt from "@tiptap/extension-underline";
import type { Editor } from "@tiptap/core";
import type { EditorView } from "@tiptap/pm/view";
import { BubbleMenu, EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  type CSSProperties,
} from "react";
import { cn } from "../lib/cn";
import { useDialogs } from "../composites/dialogs";

export interface RichEditorChange {
  readonly html: string;
  readonly text: string;
}

export interface RichEditorHandle {
  setContent(html: string): void;
  focus(): void;
  getValue(): RichEditorChange;
}

export interface RichEditorProps {
  readonly defaultValue?: string;
  readonly placeholder?: string;
  readonly minHeight?: number | string;
  readonly maxHeight?: number | string;
  readonly className?: string;
  readonly onChange?: (value: RichEditorChange) => void;
  readonly onSubmit?: () => void;
  readonly hideToolbar?: boolean;
  readonly ariaLabel?: string;
}

export const RichEditor = forwardRef<RichEditorHandle, RichEditorProps>(function RichEditor(
  {
    defaultValue,
    placeholder,
    minHeight = 140,
    maxHeight,
    className,
    onChange,
    onSubmit,
    hideToolbar,
    ariaLabel,
  },
  ref,
) {
  const dialogs = useDialogs();

  const emit = useCallback(
    (html: string) => {
      const text = htmlToText(html);
      onChange?.({ html, text });
    },
    [onChange],
  );

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({
        heading: false,
        strike: false,
      }),
      UnderlineExt,
      Link.configure({ openOnClick: false, autolink: true, linkOnPaste: true }),
      Placeholder.configure({ placeholder: placeholder ?? "" }),
      Table.configure({ resizable: true }),
      TableRow,
      TableHeader,
      TableCell,
      Image.configure({ inline: true, allowBase64: true }),
    ],
    content: defaultValue ?? "",
    editorProps: {
      attributes: {
        class: "prose-mailai outline-none px-3 py-3 text-sm leading-relaxed text-foreground",
        "aria-label": ariaLabel ?? "",
      },
      handleKeyDown: (_view: EditorView, event: KeyboardEvent) => {
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
          onSubmit?.();
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ editor: ed }: { editor: Editor }) => {
      emit(ed.getHTML());
    },
  });

  useImperativeHandle(
    ref,
    () => ({
      setContent(html: string) {
        editor?.commands.setContent(html, { emitUpdate: false });
        editor?.commands.focus("end");
        emit(html);
      },
      focus() {
        editor?.commands.focus();
      },
      getValue() {
        const html = editor?.getHTML() ?? "";
        return { html, text: htmlToText(html) };
      },
    }),
    [editor, emit],
  );

  const promptForLink = useCallback(async () => {
    if (!editor) return;
    const url = await dialogs.prompt({
      title: "Insert link",
      description: "Enter a URL — we'll prepend https:// if you skip the scheme.",
      placeholder: "https://example.com",
      inputType: "url",
      okLabel: "Insert",
    });
    if (!url) return;
    const trimmed = url.trim();
    if (trimmed.length === 0) return;
    const safe =
      /^https?:\/\//i.test(trimmed) || trimmed.startsWith("mailto:")
        ? trimmed
        : `https://${trimmed}`;
    editor.chain().focus().extendMarkRange("link").setLink({ href: safe }).run();
  }, [dialogs, editor]);

  const style: CSSProperties = { minHeight };
  if (maxHeight !== undefined) {
    style.maxHeight = maxHeight;
    style.overflowY = "auto";
  }

  if (!editor) {
    return <div className={cn("animate-pulse rounded border border-divider bg-hover/30", className)} style={style} />;
  }

  return (
    <div className={cn("flex w-full flex-col", className)}>
      {hideToolbar ? null : (
        <Toolbar
          editor={editor}
          onLinkClick={() => void promptForLink()}
          onInsertTable={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}
          onInsertImage={async () => {
            const url = await dialogs.prompt({
              title: "Insert image",
              description: "Image URL (https) or data URL.",
              placeholder: "https://…",
              inputType: "url",
              okLabel: "Insert",
            });
            if (!url?.trim()) return;
            editor.chain().focus().setImage({ src: url.trim() }).run();
          }}
        />
      )}
      <div className="relative flex-1" style={style}>
        {editor ? (
          <BubbleMenu editor={editor} tippyOptions={{ duration: 100 }} className="flex gap-0.5 rounded border border-divider bg-background p-0.5 shadow-lg">
            <IconBtn label="Bold" onClick={() => editor.chain().focus().toggleBold().run()}>
              <Bold size={14} />
            </IconBtn>
            <IconBtn label="Italic" onClick={() => editor.chain().focus().toggleItalic().run()}>
              <Italic size={14} />
            </IconBtn>
            <IconBtn label="Link" onClick={() => void promptForLink()}>
              <LinkIcon size={14} />
            </IconBtn>
          </BubbleMenu>
        ) : null}
        <EditorContent editor={editor} />
      </div>
    </div>
  );
});

function Toolbar({
  editor,
  onLinkClick,
  onInsertTable,
  onInsertImage,
}: {
  readonly editor: Editor;
  readonly onLinkClick: () => void;
  readonly onInsertTable: () => void;
  readonly onInsertImage: () => void | Promise<void>;
}) {
  const chain = () => editor.chain().focus();
  return (
    <div
      role="toolbar"
      aria-label="Formatting"
      className="flex flex-wrap items-center gap-0.5 border-b border-divider bg-background/40 px-2 py-1"
    >
      <ToolBtn label="Bold" shortcut="⌘B" onClick={() => chain().toggleBold().run()}>
        <Bold size={14} aria-hidden />
      </ToolBtn>
      <ToolBtn label="Italic" shortcut="⌘I" onClick={() => chain().toggleItalic().run()}>
        <Italic size={14} aria-hidden />
      </ToolBtn>
      <ToolBtn label="Underline" shortcut="⌘U" onClick={() => chain().toggleUnderline().run()}>
        <Underline size={14} aria-hidden />
      </ToolBtn>
      <Sep />
      <ToolBtn label="Bulleted list" onClick={() => chain().toggleBulletList().run()}>
        <List size={14} aria-hidden />
      </ToolBtn>
      <ToolBtn label="Numbered list" onClick={() => chain().toggleOrderedList().run()}>
        <ListOrdered size={14} aria-hidden />
      </ToolBtn>
      <Sep />
      <ToolBtn label="Quote" onClick={() => chain().toggleBlockquote().run()}>
        <Quote size={14} aria-hidden />
      </ToolBtn>
      <ToolBtn label="Code block" onClick={() => chain().toggleCodeBlock().run()}>
        <CodeIcon size={14} aria-hidden />
      </ToolBtn>
      <Sep />
      <ToolBtn label="Link" shortcut="⌘K" onClick={onLinkClick}>
        <LinkIcon size={14} aria-hidden />
      </ToolBtn>
      <ToolBtn label="Table" onClick={onInsertTable}>
        <TableIcon size={14} aria-hidden />
      </ToolBtn>
      <ToolBtn label="Image" onClick={() => void onInsertImage()}>
        <ImageIcon size={14} aria-hidden />
      </ToolBtn>
      <ToolBtn label="Clear formatting" onClick={() => chain().clearNodes().unsetAllMarks().run()}>
        <Eraser size={14} aria-hidden />
      </ToolBtn>
    </div>
  );
}

interface ToolBtnProps {
  readonly label: string;
  readonly shortcut?: string;
  readonly onClick: () => void;
  readonly children: React.ReactNode;
}

function ToolBtn({ label, shortcut, onClick, children }: ToolBtnProps) {
  return (
    <button
      type="button"
      title={shortcut ? `${label} (${shortcut})` : label}
      aria-label={label}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className="inline-flex h-7 w-7 items-center justify-center rounded text-xs text-secondary hover:bg-hover hover:text-foreground"
    >
      {children}
    </button>
  );
}

function IconBtn({
  label,
  onClick,
  children,
}: {
  readonly label: string;
  readonly onClick: () => void;
  readonly children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className="inline-flex h-7 w-7 items-center justify-center rounded text-secondary hover:bg-hover hover:text-foreground"
    >
      {children}
    </button>
  );
}

function Sep() {
  return <span className="mx-1 inline-block h-4 w-px bg-divider" aria-hidden />;
}

function htmlToText(html: string): string {
  if (typeof document === "undefined") return stripTags(html);
  const tmp = document.createElement("div");
  tmp.innerHTML = html;
  for (const ul of Array.from(tmp.querySelectorAll("ul"))) {
    for (const li of Array.from(ul.children)) {
      li.textContent = `• ${li.textContent ?? ""}`;
    }
  }
  for (const ol of Array.from(tmp.querySelectorAll("ol"))) {
    let n = 1;
    for (const li of Array.from(ol.children)) {
      li.textContent = `${n++}. ${li.textContent ?? ""}`;
    }
  }
  for (const a of Array.from(tmp.querySelectorAll("a"))) {
    const href = a.getAttribute("href");
    if (href && href !== a.textContent) {
      a.textContent = `${a.textContent ?? ""} (${href})`;
    }
  }
  for (const br of Array.from(tmp.querySelectorAll("br"))) {
    br.replaceWith("\n");
  }
  for (const block of Array.from(
    tmp.querySelectorAll("p,div,li,blockquote,pre,h1,h2,h3,h4,h5,h6,td,th"),
  )) {
    block.append("\n");
  }
  return (tmp.textContent ?? "").replace(/\n{3,}/g, "\n\n").trim();
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
