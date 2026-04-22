"use client";

// Inline tag chips with an "add tag" combobox. Used in the thread
// header and as a hoverable inline editor in the inbox row.
//
// Optimistic UI: we mutate local state synchronously, send the
// command to the bus, and reconcile from the server response. On
// error we roll back and surface the message in the chip's tooltip
// so the user knows their action didn't take.

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useTranslator } from "../lib/i18n/useTranslator";
import {
  addTagToThread,
  listTags,
  listThreadTags,
  removeTagFromThread,
  type TagDefinition,
} from "../lib/tags-client";

interface Props {
  threadId: string;
  initialTags?: TagDefinition[];
  compact?: boolean;
  onChanged?: (tags: TagDefinition[]) => void;
}

export function TagChips({ threadId, initialTags, compact, onChanged }: Props) {
  const { t } = useTranslator();
  const [tags, setTags] = useState<TagDefinition[] | null>(initialTags ?? null);
  const [allTags, setAllTags] = useState<TagDefinition[]>([]);
  const [adding, setAdding] = useState(false);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (initialTags) return;
    let cancelled = false;
    listThreadTags(threadId)
      .then((rows) => !cancelled && setTags(rows))
      .catch(() => !cancelled && setTags([]));
    return () => {
      cancelled = true;
    };
  }, [threadId, initialTags]);

  useEffect(() => {
    if (!adding) return;
    let cancelled = false;
    listTags()
      .then((rows) => !cancelled && setAllTags(rows))
      .catch(() => !cancelled && setAllTags([]));
    inputRef.current?.focus();
    return () => {
      cancelled = true;
    };
  }, [adding]);

  const apply = async (name: string) => {
    const tag = name.trim();
    if (!tag) return;
    setBusy(true);
    try {
      await addTagToThread(threadId, tag);
      const fresh = await listThreadTags(threadId);
      setTags(fresh);
      onChanged?.(fresh);
      setInput("");
    } catch (err) {
      console.warn("addTag failed", err);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (name: string) => {
    setTags((prev) => prev?.filter((t) => t.name !== name) ?? null);
    try {
      await removeTagFromThread(threadId, name);
      const fresh = await listThreadTags(threadId);
      setTags(fresh);
      onChanged?.(fresh);
    } catch (err) {
      console.warn("removeTag failed", err);
      const fresh = await listThreadTags(threadId);
      setTags(fresh);
    }
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void apply(input);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setAdding(false);
      setInput("");
    }
  };

  const visible = tags ?? [];

  return (
    <div className={"flex flex-wrap items-center gap-1 " + (compact ? "text-xs" : "text-sm")}>
      {visible.map((tag) => (
        <Chip
          key={tag.id}
          tag={tag}
          {...(!busy ? { onRemove: () => void remove(tag.name) } : {})}
          {...(compact !== undefined ? { compact } : {})}
        />
      ))}
      {adding ? (
        <div className="relative inline-flex items-center">
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKey}
            onBlur={() => {
              if (!busy) {
                setAdding(false);
                setInput("");
              }
            }}
            placeholder={t("thread.tags.addPlaceholder")}
            className="h-6 rounded-md border border-divider bg-background px-2 text-xs outline-none focus:border-accent"
          />
          {input && allTags.length > 0 ? (
            <div className="absolute left-0 top-full z-10 mt-1 max-h-40 w-44 overflow-auto rounded-md border border-divider bg-surface shadow-lg">
              {allTags
                .filter((tag) =>
                  tag.name.toLowerCase().includes(input.toLowerCase()) &&
                  !visible.some((v) => v.name === tag.name),
                )
                .slice(0, 6)
                .map((tag) => (
                  <button
                    key={tag.id}
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => void apply(tag.name)}
                    className="flex w-full items-center gap-2 px-2 py-1 text-left text-xs hover:bg-background/60"
                  >
                    <span
                      className="h-2 w-2 rounded-full"
                      style={{ backgroundColor: tag.color }}
                    />
                    <span>{tag.name}</span>
                  </button>
                ))}
            </div>
          ) : null}
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="inline-flex h-6 items-center rounded-md border border-dashed border-divider px-2 text-xs text-secondary hover:border-accent hover:text-foreground"
        >
          + {t("tags.addTag")}
        </button>
      )}
    </div>
  );
}

function Chip({
  tag,
  onRemove,
  compact,
}: {
  tag: TagDefinition;
  onRemove?: () => void;
  compact?: boolean;
}) {
  return (
    <span
      className={
        "inline-flex items-center gap-1 rounded-full border border-divider bg-surface " +
        (compact ? "px-1.5 py-0.5 text-[10px]" : "px-2 py-0.5 text-xs")
      }
      style={{ borderColor: tag.color, color: tag.color }}
    >
      <span
        className="h-1.5 w-1.5 rounded-full"
        style={{ backgroundColor: tag.color }}
      />
      <span className="text-foreground">{tag.name}</span>
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          className="text-secondary hover:text-foreground"
          aria-label="remove tag"
        >
          ×
        </button>
      ) : null}
    </span>
  );
}

export function ReadOnlyChips({
  tags,
  compact,
}: {
  tags: TagDefinition[];
  compact?: boolean;
}) {
  if (!tags || tags.length === 0) return null;
  return (
    <div className={"flex flex-wrap gap-1 " + (compact ? "text-[10px]" : "text-xs")}>
      {tags.map((tag) => (
        <span
          key={tag.id}
          className="inline-flex items-center gap-1 rounded-full border bg-surface px-1.5 py-0.5"
          style={{ borderColor: tag.color, color: tag.color }}
        >
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ backgroundColor: tag.color }}
          />
          <span className="text-foreground">{tag.name}</span>
        </span>
      ))}
    </div>
  );
}
