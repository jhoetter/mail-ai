"use client";

// RichEditor: a contenteditable surface with a small, opinionated
// formatting toolbar (bold, italic, underline, ordered/unordered
// lists, link, blockquote, clear formatting). Returns *both* an
// HTML and a text representation so callers can ship a multipart
// message without forcing rich clients on the recipient.
//
// We deliberately use plain contenteditable + document.execCommand
// instead of pulling in a heavy editor framework. The feature set
// the user sees in a normal mail composer is small (this set) and
// the trade-offs of TipTap/ProseMirror — bundle size, custom HTML
// schema, learning curve — aren't worth paying for that surface.
//
// `value` is uncontrolled by design: forcing a controlled HTML
// string into a contenteditable wrecks the cursor/selection on
// every keystroke. Callers receive the latest HTML/text via
// `onChange` and pass `defaultValue` only when seeding.

import {
  Bold,
  Code as CodeIcon,
  Eraser,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  Quote,
  Underline,
} from "lucide-react";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { cn } from "../lib/cn";
import { useDialogs } from "../composites/dialogs";

export interface RichEditorChange {
  readonly html: string;
  readonly text: string;
}

export interface RichEditorHandle {
  /** Replace the editor contents (cursor jumps to the end). */
  setContent(html: string): void;
  /** Move keyboard focus into the editor. */
  focus(): void;
  /** Latest value as the user sees it. */
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
  /** Hide the toolbar. Used for inline reply where space is tight. */
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
  const editorRef = useRef<HTMLDivElement | null>(null);
  const dialogs = useDialogs();
  const [empty, setEmpty] = useState(!defaultValue || defaultValue.trim().length === 0);

  const emit = useCallback(() => {
    const el = editorRef.current;
    if (!el) return;
    const html = el.innerHTML;
    const text = htmlToText(html);
    setEmpty(text.trim().length === 0);
    onChange?.({ html, text });
  }, [onChange]);

  useImperativeHandle(
    ref,
    () => ({
      setContent(html: string) {
        if (!editorRef.current) return;
        editorRef.current.innerHTML = html;
        placeCaretAtEnd(editorRef.current);
        emit();
      },
      focus() {
        editorRef.current?.focus();
      },
      getValue() {
        const html = editorRef.current?.innerHTML ?? "";
        return { html, text: htmlToText(html) };
      },
    }),
    [emit],
  );

  // Seed once on mount. Updates to `defaultValue` after mount are
  // ignored — callers wanting to overwrite the editor should call
  // `ref.current?.setContent(...)` instead.
  useEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    el.innerHTML = defaultValue ?? "";
    setEmpty(htmlToText(el.innerHTML).trim().length === 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const exec = useCallback(
    (command: string, arg?: string) => {
      // execCommand is "deprecated" but still implemented in every
      // major browser and is the only API that gives us reliable,
      // selection-aware formatting without a full editor framework.
      const ok =
        // eslint-disable-next-line @typescript-eslint/no-deprecated
        document.execCommand(command, false, arg);
      if (!ok) return;
      editorRef.current?.focus();
      emit();
    },
    [emit],
  );

  const promptForLink = useCallback(async () => {
    if (typeof window === "undefined") return;
    // The link prompt opens a dialog, which steals focus from the
    // contenteditable and wipes the user's selection. We capture the
    // active range up front and restore it before calling
    // `createLink`, otherwise the link gets inserted at the
    // start of the document (or nowhere at all).
    const selection = window.getSelection();
    const savedRange =
      selection && selection.rangeCount > 0 ? selection.getRangeAt(0).cloneRange() : null;
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
    editorRef.current?.focus();
    if (savedRange) {
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(savedRange);
    }
    exec("createLink", safe);
  }, [dialogs, exec]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "enter" && onSubmit) {
        e.preventDefault();
        onSubmit();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey) {
        const k = e.key.toLowerCase();
        if (k === "b") {
          e.preventDefault();
          exec("bold");
          return;
        }
        if (k === "i") {
          e.preventDefault();
          exec("italic");
          return;
        }
        if (k === "u") {
          e.preventDefault();
          exec("underline");
          return;
        }
        if (k === "k") {
          e.preventDefault();
          void promptForLink();
          return;
        }
      }
    },
    [exec, onSubmit, promptForLink],
  );

  // Paste cleanup: keep the formatted clipboard if it's a sensible
  // subset, otherwise drop to plain text. This is what you actually
  // want when pasting from another mail/Slack/notion — preserves
  // links + lists + emphasis without dragging in their CSS.
  const onPaste = useCallback(
    (e: React.ClipboardEvent<HTMLDivElement>) => {
      const html = e.clipboardData.getData("text/html");
      const text = e.clipboardData.getData("text/plain");
      if (!html) return;
      e.preventDefault();
      const cleaned = sanitizePastedHtml(html) || escapeText(text).replace(/\n/g, "<br>");
      // eslint-disable-next-line @typescript-eslint/no-deprecated
      document.execCommand("insertHTML", false, cleaned);
      emit();
    },
    [emit],
  );

  const style: CSSProperties = { minHeight };
  if (maxHeight !== undefined) {
    style.maxHeight = maxHeight;
    style.overflowY = "auto";
  }

  return (
    <div className={cn("flex w-full flex-col", className)}>
      {hideToolbar ? null : <Toolbar exec={exec} onLinkClick={() => void promptForLink()} />}
      <div className="relative flex-1">
        <div
          ref={editorRef}
          role="textbox"
          aria-multiline="true"
          aria-label={ariaLabel}
          contentEditable
          suppressContentEditableWarning
          spellCheck
          onInput={emit}
          onBlur={emit}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          className="prose-mailai w-full resize-none px-3 py-3 text-sm leading-relaxed text-foreground outline-none"
          style={style}
        />
        {empty && placeholder ? (
          <span className="pointer-events-none absolute left-3 top-3 text-sm text-tertiary">
            {placeholder}
          </span>
        ) : null}
      </div>
    </div>
  );
});

interface ToolbarProps {
  readonly exec: (command: string, arg?: string) => void;
  readonly onLinkClick: () => void;
}

function Toolbar({ exec, onLinkClick }: ToolbarProps) {
  return (
    <div
      role="toolbar"
      aria-label="Formatting"
      className="flex flex-wrap items-center gap-0.5 border-b border-divider bg-background/40 px-2 py-1"
    >
      <ToolBtn label="Bold" shortcut="⌘B" onClick={() => exec("bold")}>
        <Bold size={14} aria-hidden />
      </ToolBtn>
      <ToolBtn label="Italic" shortcut="⌘I" onClick={() => exec("italic")}>
        <Italic size={14} aria-hidden />
      </ToolBtn>
      <ToolBtn label="Underline" shortcut="⌘U" onClick={() => exec("underline")}>
        <Underline size={14} aria-hidden />
      </ToolBtn>
      <Sep />
      <ToolBtn label="Bulleted list" onClick={() => exec("insertUnorderedList")}>
        <List size={14} aria-hidden />
      </ToolBtn>
      <ToolBtn label="Numbered list" onClick={() => exec("insertOrderedList")}>
        <ListOrdered size={14} aria-hidden />
      </ToolBtn>
      <Sep />
      <ToolBtn label="Quote" onClick={() => exec("formatBlock", "blockquote")}>
        <Quote size={14} aria-hidden />
      </ToolBtn>
      <ToolBtn label="Code" onClick={() => exec("formatBlock", "pre")}>
        <CodeIcon size={14} aria-hidden />
      </ToolBtn>
      <Sep />
      <ToolBtn label="Link" shortcut="⌘K" onClick={onLinkClick}>
        <LinkIcon size={14} aria-hidden />
      </ToolBtn>
      <ToolBtn label="Clear formatting" onClick={() => exec("removeFormat")}>
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

function Sep() {
  return <span className="mx-1 inline-block h-4 w-px bg-divider" aria-hidden />;
}

// Convert the editor's HTML into a faithful plain-text fallback —
// preserves paragraph breaks, list bullets, and link URLs.
function htmlToText(html: string): string {
  if (typeof document === "undefined") return stripTags(html);
  const tmp = document.createElement("div");
  tmp.innerHTML = html;
  // Lists → "- " / "1. ". Doing this in DOM avoids regex-soup.
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
  // <br> → \n; block elements → \n\n.
  for (const br of Array.from(tmp.querySelectorAll("br"))) {
    br.replaceWith("\n");
  }
  for (const block of Array.from(
    tmp.querySelectorAll("p,div,li,blockquote,pre,h1,h2,h3,h4,h5,h6"),
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

function escapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Conservative paste-HTML cleaner. We strip scripts, styles, classes,
// inline event handlers, and unknown tags — keep the structural ones.
const ALLOWED = new Set([
  "A",
  "B",
  "STRONG",
  "I",
  "EM",
  "U",
  "BR",
  "P",
  "DIV",
  "SPAN",
  "BLOCKQUOTE",
  "PRE",
  "CODE",
  "UL",
  "OL",
  "LI",
  "H1",
  "H2",
  "H3",
  "H4",
]);

function sanitizePastedHtml(html: string): string {
  if (typeof document === "undefined") return stripTags(html);
  const tmp = document.createElement("div");
  tmp.innerHTML = html;
  walk(tmp);
  return tmp.innerHTML;
}

function walk(node: Element): void {
  for (const child of Array.from(node.children)) {
    if (!ALLOWED.has(child.tagName)) {
      const span = document.createElement("span");
      span.innerHTML = child.innerHTML;
      child.replaceWith(span);
      walk(span);
      continue;
    }
    for (const attr of Array.from(child.attributes)) {
      const name = attr.name.toLowerCase();
      if (child.tagName === "A" && name === "href") {
        const href = attr.value.trim();
        if (!/^(https?:|mailto:|#|\/)/i.test(href)) {
          child.removeAttribute("href");
        }
        continue;
      }
      child.removeAttribute(attr.name);
    }
    if (child.tagName === "A") {
      child.setAttribute("rel", "noopener noreferrer");
      child.setAttribute("target", "_blank");
    }
    walk(child);
  }
}

function placeCaretAtEnd(el: HTMLElement): void {
  if (typeof window === "undefined") return;
  el.focus();
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}
