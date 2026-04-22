import { useState } from "react";
import { Card, PageBody, PageHeader, Shell, Button, Input } from "@mailai/ui";
import { AppNav } from "../components/AppNav";
import { baseUrl } from "../lib/api";

interface Hit {
  threadId: string;
  subject: string;
  snippet: string;
  rank: number;
}

// Postgres-FTS-backed search. Uses baseUrl() so it picks up the same
// rewrite/proxy as every other endpoint — the previous version
// hard-coded http://127.0.0.1:8080 which (a) isn't our API port
// (8200), and (b) bypasses the Next dev rewrite entirely.
export default function SearchPage() {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [pending, setPending] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setPending(true);
    setError(null);
    try {
      const url = `${baseUrl()}/api/search?q=${encodeURIComponent(q)}`;
      const res = await fetch(url);
      setHasSearched(true);
      if (!res.ok) {
        setHits([]);
        if (res.status === 404) {
          setError(
            "Search isn't wired up yet — the /api/search endpoint hasn't been mounted in this build.",
          );
        } else {
          setError(`Search failed (HTTP ${res.status}).`);
        }
        return;
      }
      setHits(((await res.json()) as { hits: Hit[] }).hits ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setHits([]);
    } finally {
      setPending(false);
    }
  }

  return (
    <Shell sidebar={<AppNav />}>
      <PageHeader
        title="Search"
        subtitle="Full-text search across synced mail (Postgres tsvector)."
      />
      <PageBody>
      <Card>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void run();
          }}
        >
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search subjects and senders…"
            aria-label="Search query"
          />
          <Button type="submit" variant="primary" size="sm" disabled={pending || q.length === 0}>
            {pending ? "Searching…" : "Search"}
          </Button>
        </form>
        {error ? (
          <p className="mt-4 text-sm text-error">{error}</p>
        ) : (
          <ul className="mt-4 flex flex-col gap-3">
            {hits.map((h) => (
              <li key={h.threadId} className="text-sm">
                <a
                  href={`/inbox/thread/${h.threadId}`}
                  className="font-medium underline"
                >
                  {h.subject}
                </a>
                <p className="text-secondary">{h.snippet}</p>
              </li>
            ))}
            {!pending && hasSearched && hits.length === 0 ? (
              <li className="text-sm text-secondary">No results.</li>
            ) : null}
            {!hasSearched ? (
              <li className="text-sm text-secondary">
                Type a query and hit Search. Indexes are kept fresh via the FTS
                trigger on the messages table.
              </li>
            ) : null}
          </ul>
        )}
      </Card>
      </PageBody>
    </Shell>
  );
}
