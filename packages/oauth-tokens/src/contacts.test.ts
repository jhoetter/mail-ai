import { describe, expect, it, vi } from "vitest";
import {
  listGoogleConnections,
  listGoogleOtherContacts,
  listGraphContacts,
  listGraphPeople,
  pickPrimaryEmail,
} from "./contacts.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("listGoogleConnections", () => {
  it("normalizes a single page of connections", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        connections: [
          {
            resourceName: "people/c1",
            names: [{ displayName: "Alice Example" }],
            emailAddresses: [
              {
                value: "alice@example.com",
                type: "work",
                metadata: { primary: true },
              },
              { value: "alice2@example.com" },
            ],
            metadata: { sources: [{ updateTime: "2024-01-02T03:04:05Z" }] },
          },
          {
            resourceName: "people/c2",
            names: [{ displayName: "No Email" }],
            emailAddresses: [{ value: "  " }],
          },
        ],
      }),
    ) as unknown as typeof fetch;

    const out = await listGoogleConnections({
      accessToken: "tkn",
      fetchImpl,
    });

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      providerContactId: "people/c1",
      source: "my",
      displayName: "Alice Example",
    });
    expect(out[0]!.emails[0]).toMatchObject({
      address: "alice@example.com",
      type: "work",
      primary: true,
    });
    expect(out[0]!.lastInteractionAt).toBeInstanceOf(Date);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("follows pageToken across pages", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          connections: [
            {
              resourceName: "people/p1",
              emailAddresses: [{ value: "p1@example.com" }],
            },
          ],
          nextPageToken: "tok2",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          connections: [
            {
              resourceName: "people/p2",
              emailAddresses: [{ value: "p2@example.com" }],
            },
          ],
        }),
      ) as unknown as typeof fetch;

    const out = await listGoogleConnections({ accessToken: "t", fetchImpl });
    expect(out.map((c) => c.providerContactId)).toEqual(["people/p1", "people/p2"]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("throws on non-200", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("nope", { status: 401 }),
    ) as unknown as typeof fetch;
    await expect(listGoogleConnections({ accessToken: "t", fetchImpl })).rejects.toThrow(
      /google connections/,
    );
  });
});

describe("listGoogleOtherContacts", () => {
  it("tags rows with source='other'", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        otherContacts: [
          {
            resourceName: "otherContacts/x1",
            names: [{ displayName: "Bob" }],
            emailAddresses: [{ value: "bob@example.com" }],
          },
        ],
      }),
    ) as unknown as typeof fetch;

    const out = await listGoogleOtherContacts({
      accessToken: "t",
      fetchImpl,
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.source).toBe("other");
  });
});

describe("listGraphContacts", () => {
  it("normalizes contacts and follows @odata.nextLink", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          value: [
            {
              id: "AAA",
              displayName: "Carol",
              emailAddresses: [{ address: "carol@example.com" }],
              lastModifiedDateTime: "2024-03-04T05:06:07Z",
            },
          ],
          "@odata.nextLink": "https://graph/2",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          value: [
            {
              id: "BBB",
              displayName: "Dave",
              emailAddresses: [{ address: "dave@example.com" }],
            },
          ],
        }),
      ) as unknown as typeof fetch;

    const out = await listGraphContacts({ accessToken: "t", fetchImpl });
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      providerContactId: "AAA",
      source: "my",
      displayName: "Carol",
    });
    expect(out[0]!.lastInteractionAt).toBeInstanceOf(Date);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("skips contacts without id or address", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        value: [
          { id: "", emailAddresses: [{ address: "x@example.com" }] },
          { id: "Y", emailAddresses: [{ address: "" }] },
        ],
      }),
    ) as unknown as typeof fetch;

    const out = await listGraphContacts({ accessToken: "t", fetchImpl });
    expect(out).toEqual([]);
  });
});

describe("listGraphPeople", () => {
  it("orders emails by relevance and marks the top one primary", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        value: [
          {
            id: "P1",
            displayName: "Erin",
            scoredEmailAddresses: [
              { address: "low@example.com", relevanceScore: 0.1 },
              { address: "high@example.com", relevanceScore: 0.9 },
            ],
          },
        ],
      }),
    ) as unknown as typeof fetch;

    const out = await listGraphPeople({ accessToken: "t", fetchImpl });
    expect(out).toHaveLength(1);
    expect(out[0]!.source).toBe("people");
    expect(out[0]!.emails[0]).toMatchObject({
      address: "high@example.com",
      primary: true,
    });
    expect(out[0]!.emails[1]).toMatchObject({
      address: "low@example.com",
    });
    expect(out[0]!.emails[1]!.primary).toBeUndefined();
  });
});

describe("pickPrimaryEmail", () => {
  it("prefers the flagged primary entry", () => {
    expect(
      pickPrimaryEmail([
        { address: "first@example.com" },
        { address: "Primary@Example.com", primary: true },
      ]),
    ).toBe("primary@example.com");
  });

  it("falls back to first when none is flagged", () => {
    expect(
      pickPrimaryEmail([{ address: "  First@Example.com  " }, { address: "second@example.com" }]),
    ).toBe("first@example.com");
  });

  it("returns null when no addresses present", () => {
    expect(pickPrimaryEmail([])).toBeNull();
  });
});
