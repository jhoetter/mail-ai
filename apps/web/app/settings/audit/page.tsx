"use client";

import { Button, Input, PageHeader, Shell } from "@mailai/ui";
import { useCallback, useEffect, useState } from "react";
import { AppNav } from "../../components/AppNav";
import { listAudit, type AuditEntry } from "../../lib/audit-client";

export default function AuditPage() {
  const [actor, setActor] = useState("");
  const [type, setType] = useState("");
  const [since, setSince] = useState("");
  const [items, setItems] = useState<AuditEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(
    async (cursor?: string) => {
      setLoading(true);
      setErr(null);
      try {
        const page = await listAudit({
          ...(actor ? { actor } : {}),
          ...(type ? { type } : {}),
          ...(since ? { since } : {}),
          ...(cursor ? { cursor } : {}),
          limit: 50,
        });
        setItems((prev) => (cursor ? [...prev, ...page.items] : page.items));
        setNextCursor(page.nextCursor);
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [actor, type, since],
  );

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Shell sidebar={<AppNav />}>
      <PageHeader
        title="Audit log"
        subtitle="Every mutation that ever ran — append-only, durable copy of the command bus."
      />

      <form
        className="flex flex-wrap gap-2 items-end mb-3"
        onSubmit={(e) => {
          e.preventDefault();
          void load();
        }}
      >
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted">Actor</span>
          <Input
            placeholder="u_alice"
            value={actor}
            onChange={(e) => setActor(e.target.value)}
            className="w-40"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted">Type</span>
          <Input
            placeholder="mail:reply"
            value={type}
            onChange={(e) => setType(e.target.value)}
            className="w-44"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted">Since</span>
          <Input
            placeholder="1h, 24h, 7d, or ISO"
            value={since}
            onChange={(e) => setSince(e.target.value)}
            className="w-44"
          />
        </label>
        <Button type="submit" size="sm" variant="primary" disabled={loading}>
          {loading ? "…" : "Filter"}
        </Button>
      </form>

      {err ? <p className="text-sm text-danger mb-3">{err}</p> : null}

      {items.length === 0 && !loading ? (
        <p className="text-sm text-muted">No entries match the current filters.</p>
      ) : (
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border text-left text-muted">
              <th className="px-3 py-2 font-medium">Time</th>
              <th className="px-3 py-2 font-medium">Actor</th>
              <th className="px-3 py-2 font-medium">Type</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">Target</th>
              <th className="px-3 py-2 font-medium">Diff</th>
            </tr>
          </thead>
          <tbody>
            {items.map((entry) => (
              <Row key={entry.seq} entry={entry} />
            ))}
          </tbody>
        </table>
      )}

      <div className="mt-4">
        {nextCursor ? (
          <Button
            size="sm"
            variant="secondary"
            disabled={loading}
            onClick={() => void load(nextCursor)}
          >
            {loading ? "Loading…" : "Load more"}
          </Button>
        ) : items.length > 0 ? (
          <p className="text-xs text-muted">End of log.</p>
        ) : null}
      </div>
    </Shell>
  );
}

function Row({ entry }: { entry: AuditEntry }) {
  const [open, setOpen] = useState(false);
  const target = extractThreadId(entry.payload);
  return (
    <>
      <tr
        className="border-b border-border hover:bg-surface cursor-pointer"
        onClick={() => setOpen((o) => !o)}
      >
        <td className="px-3 py-2 align-top whitespace-nowrap text-xs">
          {new Date(entry.createdAt).toLocaleString()}
        </td>
        <td className="px-3 py-2 align-top text-xs">
          <code>{entry.actorId}</code>{" "}
          <span className="text-muted">({entry.source})</span>
        </td>
        <td className="px-3 py-2 align-top">
          <code className="text-xs">{entry.commandType}</code>
        </td>
        <td className="px-3 py-2 align-top text-xs">
          <span className={statusClass(entry.status)}>{entry.status}</span>
        </td>
        <td className="px-3 py-2 align-top text-xs">
          {target ? <code>{target}</code> : <span className="text-muted">—</span>}
        </td>
        <td className="px-3 py-2 align-top text-xs text-muted">
          {open ? "▾ hide" : "▸ show"}
        </td>
      </tr>
      {open ? (
        <tr className="bg-surface">
          <td colSpan={6} className="px-3 py-2">
            <div className="grid grid-cols-2 gap-3 text-xs">
              <div>
                <p className="font-medium mb-1">Payload</p>
                <pre className="overflow-x-auto rounded border border-border bg-bg p-2">
                  {JSON.stringify(entry.payload, null, 2)}
                </pre>
              </div>
              <div>
                <p className="font-medium mb-1">Diff</p>
                <pre className="overflow-x-auto rounded border border-border bg-bg p-2">
                  {JSON.stringify(entry.diff, null, 2)}
                </pre>
              </div>
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

function extractThreadId(payload: unknown): string | null {
  if (payload && typeof payload === "object" && "threadId" in payload) {
    const v = (payload as { threadId: unknown }).threadId;
    return typeof v === "string" ? v : null;
  }
  return null;
}

function statusClass(s: string): string {
  switch (s) {
    case "applied":
      return "text-success";
    case "failed":
      return "text-danger";
    case "rejected":
      return "text-warning";
    case "pending":
      return "text-muted";
    default:
      return "";
  }
}
