// Device-flow happy/sad paths. The endpoints, sleep, and clock are
// all injectable so the tests run synchronously in <50ms.

import { describe, expect, it, vi } from "vitest";
import { runDeviceFlow, pollForToken } from "./oauth-device.js";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status: ok ? status : status,
    headers: { "content-type": "application/json" },
  });
}

describe("OAuth device flow", () => {
  it("happy path: exchanges device code for token", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          device_code: "dev123",
          user_code: "ABCD-EFGH",
          verification_uri: "https://example.com/device",
          expires_in: 600,
          interval: 1,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: "tok-1",
          refresh_token: "rt",
          token_type: "Bearer",
          expires_in: 3600,
        }),
      );

    const display = vi.fn();
    const result = await runDeviceFlow(
      {
        deviceAuthEndpoint: "https://example.com/oauth/device",
        tokenEndpoint: "https://example.com/oauth/token",
        clientId: "cid",
        scope: "openid",
        fetchImpl: fetchMock,
        sleep: async () => undefined,
      },
      display,
    );
    expect(display).toHaveBeenCalledOnce();
    expect(result.tokens.access_token).toBe("tok-1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("polls through authorization_pending then succeeds", async () => {
    let poll = 0;
    const fetchImpl = vi.fn().mockImplementation(async () => {
      poll++;
      if (poll === 1) return jsonResponse({ error: "authorization_pending" }, false, 400);
      if (poll === 2) return jsonResponse({ error: "slow_down" }, false, 400);
      return jsonResponse({ access_token: "tok-2", token_type: "Bearer", expires_in: 60 });
    });
    const tokens = await pollForToken(
      {
        deviceAuthEndpoint: "x",
        tokenEndpoint: "x",
        clientId: "c",
        scope: "s",
        fetchImpl,
        sleep: async () => undefined,
      },
      {
        device_code: "d",
        user_code: "u",
        verification_uri: "v",
        expires_in: 600,
        interval: 1,
      },
    );
    expect(tokens.access_token).toBe("tok-2");
    expect(poll).toBe(3);
  });

  it("sad path: access_denied throws auth_error", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: "access_denied" }, false, 400));
    await expect(
      pollForToken(
        {
          deviceAuthEndpoint: "x",
          tokenEndpoint: "x",
          clientId: "c",
          scope: "s",
          fetchImpl,
          sleep: async () => undefined,
        },
        { device_code: "d", user_code: "u", verification_uri: "v", expires_in: 600, interval: 1 },
      ),
    ).rejects.toMatchObject({ code: "auth_error", message: /denied/ });
  });

  it("sad path: deadline exceeded throws auth_error", async () => {
    let now = 0;
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: "authorization_pending" }, false, 400));
    await expect(
      pollForToken(
        {
          deviceAuthEndpoint: "x",
          tokenEndpoint: "x",
          clientId: "c",
          scope: "s",
          fetchImpl,
          sleep: async () => {
            now += 200_000;
          },
          clock: () => now,
        },
        { device_code: "d", user_code: "u", verification_uri: "v", expires_in: 1, interval: 1 },
      ),
    ).rejects.toMatchObject({ code: "auth_error" });
  });
});
