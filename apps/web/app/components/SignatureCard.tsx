// Per-account signature editor. Lives on the Account settings page;
// renders the rich text version with the same RichEditor used in the
// composer and offers a plain-text mirror so non-HTML mail still
// gets a sensible signature.
//
// Save dispatches `account:set-signature`. On reply / forward / new
// message, the composer prepends the active account's signature.

import { Button, Card, RichEditor, type RichEditorChange, type RichEditorHandle } from "@mailai/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { baseUrl } from "../lib/api";
import { dispatchCommand } from "../lib/commands-client";
import { useTranslator } from "../lib/i18n/useTranslator";

interface AccountSignature {
  accountId: string;
  email: string;
  provider: string;
  signatureHtml: string | null;
  signatureText: string | null;
}

export function SignatureCard() {
  const { t } = useTranslator();
  const [accounts, setAccounts] = useState<AccountSignature[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${baseUrl()}/api/accounts/signatures`);
      if (!res.ok) throw new Error(`${res.status}`);
      const data = (await res.json()) as { accounts: AccountSignature[] };
      setAccounts(data.accounts);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <Card>
      <div className="mb-3">
        <h3 className="text-sm font-semibold">{t("settings.signature.title")}</h3>
        <p className="text-xs text-secondary">{t("settings.signature.subtitle")}</p>
      </div>
      {loading ? (
        <p className="text-xs text-secondary">{t("common.loading")}</p>
      ) : error ? (
        <p className="text-xs text-error">{error}</p>
      ) : accounts.length === 0 ? (
        <p className="text-xs text-secondary">{t("settings.signature.noAccounts")}</p>
      ) : (
        <div className="flex flex-col gap-6">
          {accounts.map((acc) => (
            <SignatureEditor key={acc.accountId} account={acc} onSaved={refresh} />
          ))}
        </div>
      )}
    </Card>
  );
}

function SignatureEditor({ account, onSaved }: { account: AccountSignature; onSaved: () => void }) {
  const { t } = useTranslator();
  const valueRef = useRef<RichEditorChange>({
    html: account.signatureHtml ?? "",
    text: account.signatureText ?? "",
  });
  const editorRef = useRef<RichEditorHandle | null>(null);
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const onChange = useCallback((v: RichEditorChange) => {
    valueRef.current = v;
  }, []);

  const save = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      const { html, text } = valueRef.current;
      await dispatchCommand({
        type: "account:set-signature",
        payload: {
          accountId: account.accountId,
          signatureHtml: html.trim().length > 0 ? html : null,
          signatureText: text.trim().length > 0 ? text : null,
        },
      });
      setSavedAt(Date.now());
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [account.accountId, onSaved]);

  return (
    <div className="rounded-lg border border-divider p-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-foreground">{account.email}</p>
          <p className="text-xs text-tertiary">{account.provider}</p>
        </div>
        <div className="flex items-center gap-2">
          {savedAt ? (
            <span className="text-[10px] text-tertiary">{t("settings.signature.saved")}</span>
          ) : null}
          <Button variant="primary" size="sm" onClick={() => void save()} disabled={busy}>
            {t("settings.signature.save")}
          </Button>
        </div>
      </div>
      <RichEditor
        ref={editorRef}
        ariaLabel={t("settings.signature.title")}
        defaultValue={account.signatureHtml ?? ""}
        placeholder={t("settings.signature.placeholder")}
        minHeight={120}
        maxHeight={320}
        onChange={onChange}
      />
      {err ? (
        <p className="mt-2 text-xs text-error">
          {t("settings.signature.saveError", { error: err })}
        </p>
      ) : null}
    </div>
  );
}
