import { useCallback, useEffect, useState } from "react";
import { Button, Card, PageBody, PageHeader } from "@mailai/ui";
import { PageShell } from "../../components/PageShell";
import { listAccounts, type AccountSummary } from "../../lib/oauth-client";
import { dispatchCommand } from "../../lib/commands-client";
import { useTranslator } from "../../lib/i18n/useTranslator";

export default function VacationSettingsPage() {
  const { t } = useTranslator();
  const [accounts, setAccounts] = useState<AccountSummary[]>([]);
  const [accountId, setAccountId] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const rows = await listAccounts();
    setAccounts(rows);
    if (!accountId && rows[0]) setAccountId(rows[0].id);
  }, [accountId]);

  useEffect(() => {
    void refresh().catch(() => setAccounts([]));
  }, [refresh]);

  const onSave = useCallback(async () => {
    if (!accountId) return;
    setBusy(true);
    setErr(null);
    setOk(null);
    try {
      await dispatchCommand({
        type: "account:set-vacation",
        payload: {
          accountId,
          enabled,
          subject: subject.trim() || null,
          message: message.trim() || null,
          startsAt: startsAt ? new Date(startsAt).toISOString() : null,
          endsAt: endsAt ? new Date(endsAt).toISOString() : null,
        },
      });
      setOk(t("settings.vacation.saved"));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [accountId, enabled, endsAt, message, startsAt, subject, t]);

  return (
    <PageShell>
      <PageHeader title={t("nav.vacation")} />
      <PageBody>
        <Card className="max-w-xl space-y-4 p-4">
          <p className="text-sm text-secondary">{t("settings.vacation.help")}</p>
          {err ? <p className="text-sm text-error">{err}</p> : null}
          {ok ? <p className="text-sm text-[var(--accent)]">{ok}</p> : null}
          <label className="block text-xs font-medium text-secondary">
            {t("composer.fromAccount")}
            <select
              className="mt-1 w-full rounded-md border border-divider bg-background px-2 py-1.5 text-sm text-foreground"
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
          <label className="flex items-center gap-2 text-sm text-foreground">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            {t("settings.vacation.enabled")}
          </label>
          <label className="block text-xs font-medium text-secondary">
            {t("composer.subject")}
            <input
              className="mt-1 w-full rounded-md border border-divider bg-background px-2 py-1.5 text-sm"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
            />
          </label>
          <label className="block text-xs font-medium text-secondary">
            {t("settings.vacation.message")}
            <textarea
              className="mt-1 min-h-[100px] w-full rounded-md border border-divider bg-background px-2 py-1.5 text-sm"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
            />
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-xs font-medium text-secondary">
              {t("settings.vacation.starts")}
              <input
                type="datetime-local"
                className="mt-1 w-full rounded-md border border-divider bg-background px-2 py-1.5 text-sm"
                value={startsAt}
                onChange={(e) => setStartsAt(e.target.value)}
              />
            </label>
            <label className="block text-xs font-medium text-secondary">
              {t("settings.vacation.ends")}
              <input
                type="datetime-local"
                className="mt-1 w-full rounded-md border border-divider bg-background px-2 py-1.5 text-sm"
                value={endsAt}
                onChange={(e) => setEndsAt(e.target.value)}
              />
            </label>
          </div>
          <Button variant="primary" size="sm" disabled={busy || !accountId} onClick={() => void onSave()}>
            {t("common.save")}
          </Button>
        </Card>
      </PageBody>
    </PageShell>
  );
}
