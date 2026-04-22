// Honest "this section isn't wired yet" placeholder. Used for routes
// that exist in the IA (so the sidebar link doesn't 404) but whose
// backend / UI hasn't been built. Avoid the temptation to fake data
// here — the previous DEMO inbox is exactly the kind of thing that
// made the product feel untrustworthy.

import { Card } from "@mailai/ui";
import type { ReactNode } from "react";

interface BulletPoint {
  title: string;
  detail: string;
}

interface Props {
  what: string; // one-liner: "what this section will be"
  why: string; // one-liner: "why it matters"
  bullets: BulletPoint[]; // concrete capabilities
  status: string; // e.g. "Schema + repository ready. API + UI not yet wired."
  cta?: ReactNode; // optional next-step button
}

export function ComingSoon({ what, why, bullets, status, cta }: Props) {
  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <Card>
        <div className="flex flex-col gap-3">
          <p className="text-sm">{what}</p>
          <p className="text-sm text-secondary">{why}</p>
        </div>
      </Card>
      <Card>
        <h2 className="text-sm font-semibold">What it will do</h2>
        <ul className="mt-3 flex flex-col gap-3">
          {bullets.map((b) => (
            <li key={b.title} className="text-sm">
              <span className="font-medium">{b.title}</span>
              <span className="text-secondary"> — {b.detail}</span>
            </li>
          ))}
        </ul>
      </Card>
      <Card>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold">Status</h2>
            <p className="mt-2 text-sm text-secondary">{status}</p>
          </div>
          {cta}
        </div>
      </Card>
    </div>
  );
}
