import { useCallback, useEffect, useState } from "react";
import { Button, Card, PageBody, PageHeader } from "@mailai/ui";
import { PageShell } from "../../components/PageShell";
import { apiFetch } from "../../lib/api";
import { listAccounts, type AccountSummary } from "../../lib/oauth-client";
import { useTranslator } from "../../lib/i18n/useTranslator";

interface MailRuleRow {
  id: string;
  name: string;
  enabled: boolean;
}

export default function MailRulesSettingsPage() {
  const { t } = useTranslator();
  const [accounts, setAccounts] = useState<AccountSummary[]>([]);
  const [accountId, setAccountId] = useState("");
  const [rules, setRules] = useState<MailRuleRow[]>([]);
  const [name, setName] = useState("");
  const [conditionsJson, setConditionsJson] = useState('{\n  "fromContains": "newsletter"\n}');
  const [actionsJson, setActionsJson] = useState('{\n  "markImportant": true,\n  "markRead": false\n}');
  const [loadErr, setLoadErr] = useState<string | null>(null);

  const refreshAccounts = useCallback(async () => {
    const rows = await listAccounts();
    setAccounts(rows);
    setAccountId((prev) => prev || rows[0]?.id || "");
  }, []);

  const loadRules = useCallback(async () => {
    if (!accountId) {
      setRules([]);
      return;
    }
    setLoadErr(null);
    try {
      const res = await apiFetch(`/api/mail-rules?accountId=${encodeURIComponent(accountId)}`);
      if (!res.ok) throw new Error(await res.text());
      const data = (await res.json()) as { rules: MailRuleRow[] };
      setRules(data.rules);
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : String(e));
      setRules([]);
    }
  }, [accountId]);

  useEffect(() => {
    void refreshAccounts().catch(() => setAccounts([]));
  }, [refreshAccounts]);

  useEffect(() => {
    void loadRules();
  }, [loadRules]);

  const onCreate = useCallback(async () => {
    if (!accountId || !name.trim()) return;
    let conditions: unknown;
    let actions: unknown;
    try {
      conditions = JSON.parse(conditionsJson) as unknown;
      actions = JSON.parse(actionsJson) as unknown;
    } catch {
      window.alert("Invalid JSON");
      return;
    }
    const res = await apiFetch("/api/mail-rules", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        accountId,
        name: name.trim(),
        conditions,
        actions,
      }),
    });
    if (!res.ok) {
      window.alert(await res.text());
      return;
    }
    setName("");
    await loadRules();
  }, [accountId, actionsJson, conditionsJson, loadRules, name]);

  const onDelete = useCallback(
    async (id: string) => {
      const res = await apiFetch(`/api/mail-rules/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok) {
        window.alert(await res.text());
        return;
      }
      await loadRules();
    },
    [loadRules],
  );

  return (
    <PageShell>
      <PageHeader title={t("nav.mailRules")} />
      <PageBody>
        <div className="mx-auto flex max-w-3xl flex-col gap-4">
          <Card className="space-y-3 p-4">
            <p className="text-sm text-secondary">{t("settings.mailRules.help")}</p>
            {loadErr ? <p className="text-sm text-error">{loadErr}</p> : null}
            <label className="block text-xs font-medium text-secondary">
              {t("composer.fromAccount")}
              <select
                className="mt-1 w-full rounded-md border border-divider bg-background px-2 py-1.5 text-sm"
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
              >
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.email}
                  </option>
                ))}
              </select>
            </label>
          </Card>
          <Card className="space-y-3 p-4">
            <h2 className="text-sm font-semibold text-foreground">{t("settings.mailRules.create")}</h2>
            <input
              className="w-full rounded-md border border-divider bg-background px-2 py-1.5 text-sm"
              placeholder={t("settings.mailRules.namePlaceholder")}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <label className="block text-xs text-secondary">
              conditions (JSON)
              <textarea
                className="mt-1 min-h-[120px] w-full rounded-md border border-divider bg-background px-2 py-1.5 font-mono text-xs"
                value={conditionsJson}
                onChange={(e) => setConditionsJson(e.target.value)}
              />
            </label>
            <label className="block text-xs text-secondary">
              actions (JSON)
              <textarea
                className="mt-1 min-h-[120px] w-full rounded-md border border-divider bg-background px-2 py-1.5 font-mono text-xs"
                value={actionsJson}
                onChange={(e) => setActionsJson(e.target.value)}
              />
            </label>
            <Button variant="primary" size="sm" disabled={!accountId} onClick={() => void onCreate()}>
              {t("common.new")}
            </Button>
          </Card>
          <Card className="space-y-2 p-4">
            <h2 className="text-sm font-semibold text-foreground">{t("settings.mailRules.list")}</h2>
            <ul className="divide-y divide-divider">
              {rules.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-2 py-2 text-sm">
                  <span>
                    {r.name}
                    {!r.enabled ? (
                      <span className="ml-2 text-xs text-tertiary">({t("settings.mailRules.disabled")})</span>
                    ) : null}
                  </span>
                  <Button variant="secondary" size="sm" onClick={() => void onDelete(r.id)}>
                    {t("common.delete")}
                  </Button>
                </li>
              ))}
            </ul>
            {rules.length === 0 ? <p className="text-xs text-tertiary">{t("settings.mailRules.empty")}</p> : null}
          </Card>
        </div>
      </PageBody>
    </PageShell>
  );
}
