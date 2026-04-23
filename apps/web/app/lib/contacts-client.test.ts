import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { suggestContacts } from "./contacts-client";

const realFetch = globalThis.fetch;

function mockFetch(body: unknown, status = 200): ReturnType<typeof vi.fn> {
  const fn = vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

describe("suggestContacts", () => {
  beforeEach(() => {
    delete (import.meta.env as Record<string, string | undefined>)["VITE_MAILAI_API_URL"];
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("returns the empty response without hitting the network for empty queries", async () => {
    const fn = mockFetch({ items: [], reconnect: [] });
    const out = await suggestContacts("   ");
    expect(out).toEqual({ items: [], reconnect: [] });
    expect(fn).not.toHaveBeenCalled();
  });

  it("builds a /api/contacts/suggest URL with q, accountId, and limit", async () => {
    const fn = mockFetch({ items: [], reconnect: [] });
    await suggestContacts("jt", { accountId: "acc_1", limit: 5 });
    expect(fn).toHaveBeenCalledOnce();
    const calledUrl = String(fn.mock.calls[0]![0]);
    expect(calledUrl).toMatch(/\/api\/contacts\/suggest\?/);
    expect(calledUrl).toMatch(/(?:^|[?&])q=jt(?:&|$)/);
    expect(calledUrl).toMatch(/(?:^|[?&])accountId=acc_1(?:&|$)/);
    expect(calledUrl).toMatch(/(?:^|[?&])limit=5(?:&|$)/);
  });

  it("URL-encodes the query string", async () => {
    const fn = mockFetch({ items: [], reconnect: [] });
    await suggestContacts("a@b c");
    const calledUrl = String(fn.mock.calls[0]![0]);
    expect(calledUrl).toMatch(/q=a%40b\+c/);
  });

  it("trims whitespace before sending", async () => {
    const fn = mockFetch({ items: [], reconnect: [] });
    await suggestContacts("   jt   ");
    const calledUrl = String(fn.mock.calls[0]![0]);
    expect(calledUrl).toMatch(/(?:^|[?&])q=jt(?:&|$)/);
  });

  it("uses VITE_MAILAI_API_URL when set", async () => {
    (import.meta.env as Record<string, string | undefined>)["VITE_MAILAI_API_URL"] =
      "https://api.example.com";
    const fn = mockFetch({ items: [], reconnect: [] });
    await suggestContacts("jt");
    const calledUrl = String(fn.mock.calls[0]![0]);
    expect(calledUrl).toMatch(/^https:\/\/api\.example\.com\/api\/contacts\/suggest/);
  });

  it("returns parsed JSON on success", async () => {
    mockFetch({
      items: [
        { id: "c_1", name: "JT", email: "jt@example.com", source: "other", accountId: "acc_1" },
      ],
      reconnect: [],
    });
    const out = await suggestContacts("jt");
    expect(out.items).toHaveLength(1);
    expect(out.items[0]).toMatchObject({ email: "jt@example.com" });
  });

  it("throws when the server returns a non-2xx", async () => {
    mockFetch({ error: "boom" }, 500);
    await expect(suggestContacts("jt")).rejects.toThrow(/contacts\/suggest 500/);
  });
});
