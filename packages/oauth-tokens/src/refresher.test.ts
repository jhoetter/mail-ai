import { describe, expect, it, vi } from "vitest";
import { getValidAccessToken } from "./refresher.js";
import type { OauthAccountRow, OauthAccountsRepository } from "@mailai/overlay-db";

function makeRepoStub(): OauthAccountsRepository {
  return {
    updateTokens: vi.fn(async () => undefined),
    markStatus: vi.fn(async () => undefined),
  } as unknown as OauthAccountsRepository;
}

function fakeAccount(over: Partial<OauthAccountRow> = {}): OauthAccountRow {
  return {
    id: "acc_1",
    tenantId: "t1",
    userId: "u1",
    provider: "google-mail",
    email: "alice@example.com",
    accessToken: "old_at",
    refreshToken: "rt_1",
    tokenType: "Bearer",
    scope: "https://mail.google.com/",
    expiresAt: new Date(Date.now() + 60 * 60 * 1000), // 1h ahead → fresh
    nangoConnectionId: null,
    nangoProviderConfigKey: null,
    rawJson: null,
    status: "ok",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastRefreshedAt: null,
    lastSyncedAt: null,
    lastSyncError: null,
    ...over,
  };
}

describe("getValidAccessToken", () => {
  it("returns cached token when not near expiry", async () => {
    const accounts = makeRepoStub();
    const got = await getValidAccessToken(fakeAccount(), {
      tenantId: "t1",
      accounts,
      credentials: {},
    });
    expect(got).toBe("old_at");
  });

  it("refreshes google token when within skew window", async () => {
    const accounts = makeRepoStub();
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          access_token: "new_at",
          expires_in: 3600,
          scope: "https://mail.google.com/",
          token_type: "Bearer",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ) as unknown as typeof fetch;

    const got = await getValidAccessToken(
      fakeAccount({ expiresAt: new Date(Date.now() + 60 * 1000) }), // 1m → stale
      {
        tenantId: "t1",
        accounts,
        credentials: { google: { clientId: "x", clientSecret: "y" } },
        fetchImpl,
      },
    );
    expect(got).toBe("new_at");
    expect(accounts.updateTokens).toHaveBeenCalledOnce();
  });

  it("marks needs-reauth on invalid_grant", async () => {
    const accounts = makeRepoStub();
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
    ) as unknown as typeof fetch;

    await expect(
      getValidAccessToken(
        fakeAccount({ expiresAt: new Date(Date.now() - 1000) }),
        {
          tenantId: "t1",
          accounts,
          credentials: { google: { clientId: "x", clientSecret: "y" } },
          fetchImpl,
        },
      ),
    ).rejects.toThrow(/google refresh failed/);
    expect(accounts.markStatus).toHaveBeenCalledWith("t1", "acc_1", "needs-reauth");
  });
});
