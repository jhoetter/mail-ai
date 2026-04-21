// Dedup helpers. Two messages are "the same" if they share the same
// `Message-ID`. When `Message-ID` is missing we synthesize a stable id
// from `(date, from, subject, first-recipient)` — see
// /spec/shared/data-model.md.

import { createHash } from "node:crypto";

export interface DedupSeed {
  readonly date: Date | null;
  readonly from: readonly { address: string }[];
  readonly subject: string | null;
  readonly to: readonly { address: string }[];
}

export function syntheticMessageId(seed: DedupSeed, hostname = "mailai.local"): string {
  const h = createHash("sha256");
  h.update(seed.date ? seed.date.toISOString() : "");
  h.update("\n");
  h.update(seed.from.map((a) => a.address.toLowerCase()).join(","));
  h.update("\n");
  h.update(seed.subject ?? "");
  h.update("\n");
  h.update((seed.to[0]?.address ?? "").toLowerCase());
  return `<synth-${h.digest("hex").slice(0, 32)}@${hostname}>`;
}
