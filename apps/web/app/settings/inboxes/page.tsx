import { Button, DataTable, Dialog, Input, PageBody, PageHeader, useDialogs } from "@mailai/ui";
import { useCallback, useEffect, useState } from "react";
import { PageShell } from "../../components/PageShell";
import {
  addMailbox,
  addMember,
  createInbox,
  deleteInbox,
  getInbox,
  listInboxes,
  removeMember,
  type InboxDetail,
  type InboxRole,
  type InboxRow,
} from "../../lib/inboxes-client";

export default function InboxesSettingsPage() {
  const [rows, setRows] = useState<InboxRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [drawerId, setDrawerId] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setRows(null);
    listInboxes()
      .then(setRows)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <PageShell>
      <PageHeader
        title="Inboxes"
        subtitle="Shared queues that route mail from one or more accounts to a team."
      />
      <PageBody>
        <div className="flex justify-end mb-3">
          <Button size="sm" variant="primary" onClick={() => setCreating(true)}>
            New inbox
          </Button>
        </div>

        {error ? <p className="text-sm text-error mb-3">{error}</p> : null}

        {rows === null ? (
          <p className="text-sm text-secondary">Loading…</p>
        ) : rows.length === 0 ? (
          <div className="rounded-md border border-dashed border-divider p-6 text-sm text-secondary">
            No inboxes yet. Click <span className="font-medium text-foreground">New inbox</span> to
            create one — pick a name now, wire accounts and members from the row drawer.
          </div>
        ) : (
          <DataTable<InboxRow>
            rows={rows}
            columns={[
              { key: "name", header: "Name" },
              {
                key: "description",
                header: "Description",
                render: (r) => r.description ?? "—",
              },
              { key: "id", header: "ID", render: (r) => <code className="text-xs">{r.id}</code> },
            ]}
            onRowClick={(r) => setDrawerId(r.id)}
          />
        )}
      </PageBody>

      <CreateDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={() => {
          setCreating(false);
          refresh();
        }}
      />

      {drawerId ? (
        <InboxDrawer
          id={drawerId}
          onClose={() => setDrawerId(null)}
          onDeleted={() => {
            setDrawerId(null);
            refresh();
          }}
        />
      ) : null}
    </PageShell>
  );
}

function CreateDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setName("");
      setDescription("");
      setErr(null);
      setBusy(false);
    }
  }, [open]);

  return (
    <Dialog open={open} onClose={onClose}>
      <h3 className="text-base font-semibold">Create inbox</h3>
      <p className="text-xs text-secondary mt-1">
        You can wire accounts and members after creating.
      </p>
      <div className="mt-4 flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Name</span>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Support"
            autoFocus
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Description (optional)</span>
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Customer support escalation queue"
          />
        </label>
        {err ? <p className="text-sm text-error">{err}</p> : null}
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="secondary" size="sm" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="sm"
          disabled={busy || name.trim().length === 0}
          onClick={async () => {
            setBusy(true);
            setErr(null);
            try {
              await createInbox({
                name: name.trim(),
                description: description.trim() || null,
              });
              onCreated();
            } catch (e) {
              setErr(e instanceof Error ? e.message : String(e));
              setBusy(false);
            }
          }}
        >
          {busy ? "Creating…" : "Create"}
        </Button>
      </div>
    </Dialog>
  );
}

function InboxDrawer({
  id,
  onClose,
  onDeleted,
}: {
  id: string;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const dialogs = useDialogs();
  const [detail, setDetail] = useState<InboxDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [memberId, setMemberId] = useState("");
  const [memberRole, setMemberRole] = useState<InboxRole>("agent");
  const [accountId, setAccountId] = useState("");
  const [mailboxPath, setMailboxPath] = useState("INBOX");

  const load = useCallback(() => {
    setDetail(null);
    getInbox(id)
      .then(setDetail)
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <Dialog open={true} onClose={onClose}>
      {!detail ? (
        <p className="text-sm text-secondary">Loading…</p>
      ) : (
        <div className="flex flex-col gap-4">
          <header>
            <h3 className="text-base font-semibold">{detail.name}</h3>
            <p className="text-xs text-secondary mt-1">
              {detail.description ?? "No description"} · <code>{detail.id}</code>
            </p>
          </header>

          <section className="flex flex-col gap-2">
            <h4 className="text-sm font-medium">Members ({detail.members.length})</h4>
            <ul className="text-sm flex flex-col gap-1">
              {detail.members.length === 0 ? (
                <li className="text-secondary">No members yet.</li>
              ) : (
                detail.members.map((m) => (
                  <li
                    key={`${m.inboxId}:${m.userId}`}
                    className="flex items-center justify-between"
                  >
                    <span>
                      <code className="text-xs">{m.userId}</code>{" "}
                      <span className="text-secondary">({m.role})</span>
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={async () => {
                        await removeMember(id, m.userId);
                        load();
                      }}
                    >
                      Remove
                    </Button>
                  </li>
                ))
              )}
            </ul>
            <div className="flex gap-2 items-end">
              <Input
                placeholder="user id (e.g. u_alice)"
                value={memberId}
                onChange={(e) => setMemberId(e.target.value)}
              />
              <select
                className="h-9 rounded-md border border-divider bg-background px-2 text-sm"
                value={memberRole}
                onChange={(e) => setMemberRole(e.target.value as InboxRole)}
              >
                <option value="inbox-admin">inbox-admin</option>
                <option value="agent">agent</option>
                <option value="viewer">viewer</option>
              </select>
              <Button
                size="sm"
                variant="secondary"
                disabled={memberId.trim().length === 0}
                onClick={async () => {
                  await addMember(id, memberId.trim(), memberRole);
                  setMemberId("");
                  load();
                }}
              >
                Add
              </Button>
            </div>
          </section>

          <section className="flex flex-col gap-2">
            <h4 className="text-sm font-medium">Sources ({detail.mailboxes.length})</h4>
            <ul className="text-sm flex flex-col gap-1">
              {detail.mailboxes.length === 0 ? (
                <li className="text-secondary">No mailbox sources wired yet.</li>
              ) : (
                detail.mailboxes.map((mb) => (
                  <li key={`${mb.accountId}:${mb.mailboxPath}`}>
                    <code className="text-xs">{mb.accountId}</code> · {mb.mailboxPath}
                  </li>
                ))
              )}
            </ul>
            <div className="flex gap-2 items-end">
              <Input
                placeholder="account id (oa_…)"
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
              />
              <Input
                placeholder="mailbox path"
                value={mailboxPath}
                onChange={(e) => setMailboxPath(e.target.value)}
              />
              <Button
                size="sm"
                variant="secondary"
                disabled={accountId.trim().length === 0 || mailboxPath.trim().length === 0}
                onClick={async () => {
                  await addMailbox(id, accountId.trim(), mailboxPath.trim());
                  setAccountId("");
                  load();
                }}
              >
                Add
              </Button>
            </div>
          </section>

          {err ? <p className="text-sm text-error">{err}</p> : null}
          <div className="flex justify-between pt-3 border-t border-divider">
            <Button
              size="sm"
              variant="ghost"
              onClick={async () => {
                const ok = await dialogs.confirm({
                  title: `Delete inbox "${detail.name}"?`,
                  description: "This can't be undone.",
                  confirmLabel: "Delete",
                  tone: "danger",
                });
                if (!ok) return;
                await deleteInbox(id);
                onDeleted();
              }}
            >
              Delete inbox
            </Button>
            <Button size="sm" variant="primary" onClick={onClose}>
              Done
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
