import { Button, Card, Input, PageBody, PageHeader, useDialogs } from "@mailai/ui";
import { useCallback, useEffect, useState } from "react";
import { PageShell } from "../../components/PageShell";
import { useTranslator } from "../../lib/i18n/useTranslator";
import { createTag, deleteTag, listTags, type TagDefinition } from "../../lib/tags-client";

export default function TagsSettingsPage() {
  const { t } = useTranslator();
  const dialogs = useDialogs();
  const [rows, setRows] = useState<TagDefinition[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    setRows(null);
    setError(null);
    listTags()
      .then(setRows)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const onCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      await createTag(trimmed);
      setName("");
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const onDelete = async (tag: TagDefinition) => {
    const ok = await dialogs.confirm({
      title: `Delete tag "${tag.name}"?`,
      confirmLabel: "Delete",
      tone: "danger",
    });
    if (!ok) return;
    try {
      await deleteTag(tag.id);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <PageShell>
      <PageHeader title={t("tags.title")} subtitle={t("tags.subtitle")} />
      <PageBody>
        <Card>
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-2">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("tags.newTagPlaceholder")}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void onCreate();
                  }
                }}
              />
              <Button
                variant="primary"
                size="sm"
                disabled={busy || name.trim().length === 0}
                onClick={() => void onCreate()}
              >
                {t("tags.create")}
              </Button>
            </div>
            {error ? (
              <p className="text-sm text-error">{error}</p>
            ) : rows === null ? (
              <p className="text-sm text-secondary">{t("common.loading")}</p>
            ) : rows.length === 0 ? (
              <p className="text-sm text-secondary">{t("tags.noTags")}</p>
            ) : (
              <ul className="divide-y divide-divider">
                {rows.map((tag) => (
                  <li key={tag.id} className="flex items-center gap-3 py-2">
                    <span
                      className="inline-block h-3 w-3 rounded-full"
                      style={{ backgroundColor: tag.color }}
                    />
                    <span className="flex-1 text-sm">{tag.name}</span>
                    <span className="text-xs text-secondary">
                      {tag.count === 1
                        ? t("tags.countOne")
                        : t("tags.count", { count: tag.count ?? 0 })}
                    </span>
                    <Button size="sm" variant="ghost" onClick={() => void onDelete(tag)}>
                      {t("common.delete")}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>
      </PageBody>
    </PageShell>
  );
}
