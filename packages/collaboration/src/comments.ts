// Comment validation. The mention parser is regex-based: @username
// tokens map to userIds via a lookup callback (kept out of this layer
// so it stays sync-safe).

const MENTION_RE = /(?<![\w@])@([a-zA-Z0-9_-]{2,64})/g;

export function extractMentionHandles(text: string): string[] {
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = MENTION_RE.exec(text))) {
    if (m[1]) out.add(m[1].toLowerCase());
  }
  return Array.from(out);
}
