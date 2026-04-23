import { Button, Card, PageBody, PageHeader, useDialogs } from "@mailai/ui";
import { useCallback, useEffect, useState } from "react";
import { PageShell } from "../components/PageShell";
import { Composer } from "../components/Composer";
import { useTranslator } from "../lib/i18n/useTranslator";
import { deleteDraft, listDrafts, sendDraft, type DraftSummary } from "../lib/drafts-client";

export default function DraftsPage() {
  const { t } = useTranslator();
  const dialogs = useDialogs();
  const [drafts, setDrafts] = useState<DraftSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingDraft, setEditingDraft] = useState<DraftSummary | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setDrafts(null);
    setError(null);
    listDrafts()
      .then(setDrafts)
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
        setDrafts([]);
      });
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const onSend = async (draft: DraftSummary) => {
    setBusyId(draft.id);
    try {
      await sendDraft(draft.id);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  const onDelete = async (draft: DraftSummary) => {
    const ok = await dialogs.confirm({
      title: "Discard this draft?",
      description: draft.subject ? `"${draft.subject}" will be deleted.` : undefined,
      confirmLabel: "Discard",
      tone: "danger",
    });
    if (!ok) return;
    setBusyId(draft.id);
    try {
      await deleteDraft(draft.id);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <PageShell>
      <PageHeader title={t("drafts.title")} subtitle={t("drafts.subtitle")} />
      <PageBody>
        <Card>
          {error ? (
            <p className="text-sm text-error">{error}</p>
          ) : drafts === null ? (
            <p className="text-sm text-secondary">{t("common.loading")}</p>
          ) : drafts.length === 0 ? (
            <p className="text-sm text-secondary">{t("drafts.empty")}</p>
          ) : (
            <ul className="divide-y divide-divider">
              {drafts.map((draft) => (
                <li key={draft.id} className="flex items-center gap-3 py-3">
                  <button
                    type="button"
                    className="flex-1 text-left"
                    onClick={() => setEditingDraft(draft)}
                  >
                    <div className="font-medium">{draft.subject || t("common.untitled")}</div>
                    <div className="text-xs text-secondary">
                      {draft.to.length > 0 ? draft.to.join(", ") : "—"} ·{" "}
                      {t("drafts.lastEdited", { when: formatRelative(draft.updatedAt) })}
                    </div>
                    {draft.bodyText ? (
                      <div className="mt-1 line-clamp-2 text-xs text-secondary">
                        {draft.bodyText}
                      </div>
                    ) : null}
                  </button>
                  <div className="flex shrink-0 gap-1">
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={busyId === draft.id}
                      onClick={() => void onSend(draft)}
                    >
                      {t("drafts.send")}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busyId === draft.id}
                      onClick={() => void onDelete(draft)}
                    >
                      {t("drafts.discard")}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </PageBody>
      {editingDraft ? (
        <Composer
          open
          draftId={editingDraft.id}
          initialDraft={editingDraft}
          onClose={() => {
            setEditingDraft(null);
            refresh();
          }}
        />
      ) : null}
    </PageShell>
  );
}

function formatRelative(iso: string): string {
  const ts = new Date(iso).getTime();
  const diff = Date.now() - ts;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return "just now";
  if (diff < hour) return `${Math.floor(diff / minute)}m ago`;
  if (diff < day) return `${Math.floor(diff / hour)}h ago`;
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}
