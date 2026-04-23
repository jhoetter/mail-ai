// Contract test suite. Every MailProvider implementation has to
// pass the same battery of tests so the registry can swap them
// freely. The fake fetch route table is keyed by URL prefix; each
// adapter's wire-level helpers all use a shared fetch global, so
// we stub it once per test and replay canned JSON.
//
// The point of "contract" tests vs unit tests is that we don't
// reach into adapter internals — we exercise them only through
// the MailProvider port. If a future adapter (Fastmail, IMAP) is
// added, registering it in the `cases` array below is enough to
// guarantee parity.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MailProviderRegistry, type MailProvider, type WellKnownFolder } from "@mailai/providers";
import { GoogleMailAdapter } from "./google-mail.js";
import { OutlookMailAdapter } from "./outlook-mail.js";

interface RouteHandler {
  (url: string, init: RequestInit | undefined): Response | Promise<Response>;
}

class FetchStub {
  private routes: Array<{ match: RegExp; handler: RouteHandler }> = [];
  calls: Array<{ url: string; method: string }> = [];

  on(match: RegExp, handler: RouteHandler): void {
    this.routes.push({ match, handler });
  }

  fetch = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as { url: string }).url;
    const method = init?.method ?? "GET";
    this.calls.push({ url, method });
    for (const route of this.routes) {
      if (route.match.test(url)) return route.handler(url, init);
    }
    throw new Error(`fetch stub: no route for ${method} ${url}`);
  };
}

interface AdapterCase {
  readonly id: string;
  readonly adapter: MailProvider;
  // Each case wires its own canned wire responses. The tests
  // themselves are provider-agnostic.
  readonly install: (stub: FetchStub) => void;
  // Provider-specific message id used in tests. Returned by the
  // canned listMessages response and matched in fetchBody/setRead.
  readonly messageId: string;
  // What folder name to expect in the listFolders output for
  // each well-known folder we test against.
  readonly folderId: { sent: string; inbox: string };
}

function googleCase(): AdapterCase {
  const messageId = "199abcd00";
  return {
    id: "google-mail",
    adapter: new GoogleMailAdapter(),
    messageId,
    folderId: { sent: "SENT", inbox: "INBOX" },
    install: (stub) => {
      stub.on(/users\/me\/messages\?.*labelIds=INBOX/, () =>
        Response.json({
          messages: [{ id: messageId, threadId: "thr_1" }],
          resultSizeEstimate: 1,
        }),
      );
      stub.on(new RegExp(`/messages/${messageId}\\?format=metadata`), () =>
        Response.json({
          id: messageId,
          threadId: "thr_1",
          labelIds: ["INBOX", "UNREAD"],
          snippet: "hi there",
          internalDate: "1700000000000",
          payload: {
            headers: [
              { name: "From", value: "Alice <alice@example.com>" },
              { name: "Subject", value: "Hello" },
              { name: "To", value: "bob@example.com" },
            ],
          },
        }),
      );
      stub.on(new RegExp(`/messages/${messageId}\\?format=full`), () =>
        Response.json({
          id: messageId,
          threadId: "thr_1",
          payload: {
            mimeType: "text/plain",
            body: { size: 5, data: Buffer.from("hello").toString("base64") },
          },
        }),
      );
      stub.on(new RegExp(`/messages/${messageId}\\?format=raw`), () =>
        Response.json({ raw: Buffer.from("RAW").toString("base64") }),
      );
      stub.on(/messages\/send/, () =>
        Response.json({
          id: "sent_xyz",
          threadId: "thr_xyz",
          labelIds: ["SENT"],
        }),
      );
      stub.on(new RegExp(`/messages/${messageId}/modify`), () => Response.json({ ok: true }));
      // pullDelta baseline path: /users/me/profile returns the
      // current historyId without listing any messages.
      stub.on(/users\/me\/profile/, () => Response.json({ historyId: "12345" }));
    },
  };
}

function outlookCase(): AdapterCase {
  const messageId = "AAMkAD";
  return {
    id: "outlook",
    adapter: new OutlookMailAdapter(),
    messageId,
    folderId: { sent: "SentItems", inbox: "Inbox" },
    install: (stub) => {
      // Delta endpoint MUST register before the listMessages
      // endpoint because both URLs share the same prefix and
      // FetchStub returns first-match.
      stub.on(/mailFolders\/Inbox\/messages\/delta/, () =>
        Response.json({
          value: [],
          "@odata.deltaLink":
            "https://graph.microsoft.com/v1.0/me/mailFolders/Inbox/messages/delta?$deltatoken=baseline",
        }),
      );
      stub.on(/mailFolders\/Inbox\/messages/, () =>
        Response.json({
          value: [
            {
              id: messageId,
              conversationId: "conv_1",
              subject: "Hi",
              bodyPreview: "preview",
              receivedDateTime: "2024-01-01T00:00:00Z",
              isRead: false,
              categories: [],
              from: {
                emailAddress: { name: "Alice", address: "alice@example.com" },
              },
              toRecipients: [{ emailAddress: { name: "Bob", address: "bob@example.com" } }],
            },
          ],
        }),
      );
      stub.on(new RegExp(`/me/messages/${messageId}\\?\\$select=`), () =>
        Response.json({
          id: messageId,
          conversationId: "conv_1",
          body: { contentType: "html", content: "<p>hi</p>" },
          attachments: [],
        }),
      );
      stub.on(
        new RegExp(`/me/messages/${messageId}/\\$value`),
        () => new Response(Buffer.from("RAW")),
      );
      stub.on(/me\/sendMail/, () => new Response(null, { status: 202 }));
      stub.on(new RegExp(`/me/messages/${messageId}$`), () => new Response(null, { status: 200 }));
    },
  };
}

const cases: ReadonlyArray<AdapterCase> = [googleCase(), outlookCase()];

describe.each(cases)("MailProvider contract: $id", (c) => {
  let stub: FetchStub;
  let restore: () => void;

  beforeEach(() => {
    stub = new FetchStub();
    c.install(stub);
    const original = globalThis.fetch;
    globalThis.fetch = stub.fetch as unknown as typeof globalThis.fetch;
    restore = () => {
      globalThis.fetch = original;
    };
  });

  afterEach(() => {
    restore();
    vi.restoreAllMocks();
  });

  it("advertises a provider id", () => {
    expect(c.adapter.id).toBe(c.id);
  });

  it("advertises capabilities exhaustively", () => {
    const cap = c.adapter.capabilities;
    // Force the test to be updated when MailProviderCapabilities
    // grows a new flag — adapters must opt in or out per cap.
    expect(Object.keys(cap).sort()).toEqual(["delta", "push", "synchronousSendId"].sort());
    for (const v of Object.values(cap)) expect(typeof v).toBe("boolean");
  });

  it("listFolders includes inbox and sent with provider-specific ids", async () => {
    const folders = await c.adapter.listFolders({ accessToken: "tok" });
    const byKind = new Map<WellKnownFolder, string | null>();
    for (const f of folders) byKind.set(f.wellKnownFolder, f.providerFolderId);
    expect(byKind.get("inbox")).toBe(c.folderId.inbox);
    expect(byKind.get("sent")).toBe(c.folderId.sent);
  });

  it("listMessages returns NormalizedMessage shape", async () => {
    const page = await c.adapter.listMessages({
      accessToken: "tok",
      folder: "inbox",
      pageSize: 5,
      cursor: null,
    });
    expect(page.messages.length).toBeGreaterThan(0);
    const m = page.messages[0]!;
    expect(m.providerMessageId).toBe(c.messageId);
    expect(m.from?.email).toBe("alice@example.com");
    expect(m.flags).toContain("unread");
  });

  it("fetchMessageBody returns text or html", async () => {
    const body = await c.adapter.fetchMessageBody({
      accessToken: "tok",
      providerMessageId: c.messageId,
    });
    expect(body.text !== null || body.html !== null).toBe(true);
  });

  it("fetchRawMime returns Buffer", async () => {
    const buf = await c.adapter.fetchRawMime({
      accessToken: "tok",
      providerMessageId: c.messageId,
    });
    expect(Buffer.isBuffer(buf)).toBe(true);
  });

  it("send returns providerMessageId and providerThreadId", async () => {
    const result = await c.adapter.send({
      accessToken: "tok",
      message: {
        raw: Buffer.from("From: a\r\nTo: b\r\n\r\nhi"),
        rfc822MessageId: "<local@example.com>",
      },
    });
    expect(typeof result.providerMessageId).toBe("string");
    expect(result.providerMessageId.length).toBeGreaterThan(0);
  });

  it("setRead and setStarred call without throwing", async () => {
    await c.adapter.setRead({
      accessToken: "tok",
      providerMessageId: c.messageId,
      read: true,
    });
    await c.adapter.setStarred({
      accessToken: "tok",
      providerMessageId: c.messageId,
      starred: true,
    });
  });

  it("pullDelta with no watermark baselines and returns an empty change set", async () => {
    const r = await c.adapter.pullDelta({ accessToken: "tok", since: null });
    expect(r.inserted).toEqual([]);
    expect(r.updated).toEqual([]);
    expect(r.deleted).toEqual([]);
    // Both adapters MUST hand back a watermark on the first call so
    // the next tick can take the delta path. Gmail returns its
    // mailbox historyId; Graph returns its first deltaLink.
    expect(r.nextWatermark).not.toBeNull();
  });
});

describe("MailProviderRegistry", () => {
  it("looks up adapters by provider id and rejects unknown", () => {
    const reg = new MailProviderRegistry();
    const g = new GoogleMailAdapter();
    const o = new OutlookMailAdapter();
    reg.register(g);
    reg.register(o);
    expect(reg.for("google-mail")).toBe(g);
    expect(reg.for("outlook")).toBe(o);
  });

  it("rejects double registration", () => {
    const reg = new MailProviderRegistry();
    reg.register(new GoogleMailAdapter());
    expect(() => reg.register(new GoogleMailAdapter())).toThrow(/already registered/);
  });

  it("throws when an adapter is missing", () => {
    const reg = new MailProviderRegistry();
    expect(() => reg.for("google-mail")).toThrow(/no mail adapter registered/);
  });
});
