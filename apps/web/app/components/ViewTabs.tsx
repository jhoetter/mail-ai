// Notion-style view tabs above the inbox list. Each tab is a saved
// (filter, sort, group) tuple stored server-side in the `views` table,
// so the same tabs follow the user across browsers.

import { useCallback, useEffect, useState } from "react";
import { useTranslator } from "../lib/i18n/useTranslator";
import { listViews, type ViewSummary } from "../lib/views-client";

const STORAGE_KEY = "mailai.activeViewId";

export function useActiveView(): {
  viewId: string | null;
  setViewId: (id: string | null) => void;
} {
  const [viewId, setViewIdState] = useState<string | null>(null);
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      setViewIdState(raw && raw !== "null" ? raw : null);
    } catch {}
  }, []);
  const setViewId = useCallback((id: string | null) => {
    setViewIdState(id);
    try {
      window.localStorage.setItem(STORAGE_KEY, id ?? "null");
    } catch {}
  }, []);
  return { viewId, setViewId };
}

interface Props {
  activeId: string | null;
  onChange: (id: string | null) => void;
}

export function ViewTabs({ activeId, onChange }: Props) {
  const { t } = useTranslator();
  const [views, setViews] = useState<ViewSummary[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    listViews()
      .then((rows) => !cancelled && setViews(rows))
      .catch(() => !cancelled && setViews([]));
    return () => {
      cancelled = true;
    };
  }, []);

  if (!views) {
    return <div className="h-9 shrink-0 border-b border-divider bg-surface" />;
  }

  return (
    <div className="flex shrink-0 items-center gap-0.5 overflow-x-auto border-b border-divider bg-surface px-2 py-1">
      <Tab
        label={t("views.all")}
        active={activeId === null}
        onClick={() => onChange(null)}
      />
      {views.map((view) => (
        <Tab
          key={view.id}
          label={view.name}
          active={activeId === view.id}
          onClick={() => onChange(view.id)}
        />
      ))}
    </div>
  );
}

function Tab({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "rounded-md px-2 py-1 text-xs font-medium transition-colors " +
        (active
          ? "bg-accent-light text-accent"
          : "text-secondary hover:bg-hover hover:text-foreground")
      }
    >
      {label}
    </button>
  );
}
