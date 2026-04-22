// Cross-runtime UUID generator.
//
// `node:crypto` would force every consumer (including browser bundles
// produced by @mailai/react-app via esbuild) to ship a Node polyfill or
// be marked as a Node target. Instead we lean on the Web Crypto API,
// which is available on `globalThis.crypto` in:
//
//   - All evergreen browsers since 2022
//   - Node ≥ 19.0 (where `globalThis.crypto` was promoted to a global)
//   - Workers (Cloudflare, Deno, Bun)
//
// If a host somehow lacks it (very old Node, esoteric runtime) we fall
// back to a Math.random()-based v4 — non-cryptographically-strong, but
// good enough for the only place we use this (idempotency-cache keys
// and session-id defaults). Production deploys will always hit the
// crypto path.
interface CryptoLike {
  randomUUID?: () => string;
  getRandomValues?: <T extends ArrayBufferView>(buf: T) => T;
}

export function randomId(): string {
  const c = (globalThis as { crypto?: CryptoLike }).crypto;
  if (c && typeof c.randomUUID === "function") {
    return c.randomUUID();
  }
  if (c && typeof c.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    c.getRandomValues(bytes);
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
    return (
      hex.slice(0, 4).join("") +
      "-" +
      hex.slice(4, 6).join("") +
      "-" +
      hex.slice(6, 8).join("") +
      "-" +
      hex.slice(8, 10).join("") +
      "-" +
      hex.slice(10, 16).join("")
    );
  }
  // Last-resort fallback (math-random). Not cryptographically secure,
  // only triggered on runtimes without Web Crypto — should be unreachable
  // in production.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    const v = ch === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
