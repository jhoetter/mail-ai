"use client";

import { useState } from "react";
import { Card, PageHeader, Shell, Button, Input } from "@mailai/ui";

interface Hit {
  threadId: string;
  subject: string;
  snippet: string;
  rank: number;
}

export default function SearchPage() {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [pending, setPending] = useState(false);

  async function run() {
    setPending(true);
    try {
      const url = new URL(
        `${process.env["NEXT_PUBLIC_MAILAI_API_URL"] ?? "http://127.0.0.1:8080"}/api/search`,
      );
      url.searchParams.set("q", q);
      const res = await fetch(url.toString());
      if (!res.ok) {
        setHits([]);
        return;
      }
      setHits(((await res.json()) as { hits: Hit[] }).hits ?? []);
    } finally {
      setPending(false);
    }
  }

  return (
    <Shell sidebar={<nav className="text-sm"><a href="/inbox">Inbox</a></nav>}>
      <PageHeader title="Search" subtitle="Postgres tsvector full-text search across messages" />
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
            placeholder="ENTER A SEARCH QUERY"
            aria-label="Search query"
          />
          <Button type="submit" variant="primary" size="sm" disabled={pending || q.length === 0}>
            {pending ? "Searching…" : "Search"}
          </Button>
        </form>
        <ul className="mt-4 flex flex-col gap-2">
          {hits.map((h) => (
            <li key={h.threadId} className="text-sm">
              <a href={`/inbox/thread/${h.threadId}`} className="font-medium underline">
                {h.subject}
              </a>
              <p className="text-muted">{h.snippet}</p>
            </li>
          ))}
          {!pending && hits.length === 0 ? <li className="text-sm text-muted">No results.</li> : null}
        </ul>
      </Card>
    </Shell>
  );
}
