// RFC 8628 OAuth 2.0 Device Authorization Grant.
//
// Flow: POST device-authorization endpoint -> show user the
// verification_uri + user_code -> poll the token endpoint at the
// server-provided interval until we get a token, an error, or the
// `expires_in` window closes.
//
// We deliberately keep this function pure (no keyring writes, no
// console output): the caller (CLI) decides how to display the code
// and where to persist tokens. That keeps it unit-testable with a
// mocked fetch.

import { MailaiError } from "@mailai/core";

export interface DeviceFlowConfig {
  readonly deviceAuthEndpoint: string;
  readonly tokenEndpoint: string;
  readonly clientId: string;
  readonly scope: string;
  readonly fetchImpl?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly clock?: () => number;
}

export interface DeviceCodeResponse {
  readonly device_code: string;
  readonly user_code: string;
  readonly verification_uri: string;
  readonly verification_uri_complete?: string;
  readonly expires_in: number;
  readonly interval: number;
}

export interface DeviceTokenResponse {
  readonly access_token: string;
  readonly refresh_token?: string;
  readonly token_type: string;
  readonly expires_in: number;
  readonly scope?: string;
}

export interface DeviceFlowResult {
  readonly code: DeviceCodeResponse;
  readonly tokens: DeviceTokenResponse;
}

export async function startDeviceCode(cfg: DeviceFlowConfig): Promise<DeviceCodeResponse> {
  const fetchImpl = cfg.fetchImpl ?? globalThis.fetch;
  const res = await fetchImpl(cfg.deviceAuthEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: cfg.clientId, scope: cfg.scope }).toString(),
  });
  if (!res.ok) {
    throw new MailaiError("auth_error", `device-code request failed: HTTP ${res.status}`);
  }
  return (await res.json()) as DeviceCodeResponse;
}

export async function pollForToken(
  cfg: DeviceFlowConfig,
  code: DeviceCodeResponse,
  onPoll?: (status: "pending" | "slow_down") => void,
): Promise<DeviceTokenResponse> {
  const fetchImpl = cfg.fetchImpl ?? globalThis.fetch;
  const sleep = cfg.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const clock = cfg.clock ?? (() => Date.now());
  const deadline = clock() + code.expires_in * 1000;
  let interval = code.interval;

  while (clock() < deadline) {
    await sleep(interval * 1000);
    const res = await fetchImpl(cfg.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: code.device_code,
        client_id: cfg.clientId,
      }).toString(),
    });
    if (res.ok) {
      return (await res.json()) as DeviceTokenResponse;
    }
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    switch (body.error) {
      case "authorization_pending":
        onPoll?.("pending");
        continue;
      case "slow_down":
        interval += 5;
        onPoll?.("slow_down");
        continue;
      case "expired_token":
        throw new MailaiError("auth_error", "device code expired");
      case "access_denied":
        throw new MailaiError("auth_error", "user denied authorization");
      default:
        throw new MailaiError("auth_error", `device flow failed: ${body.error ?? res.status}`);
    }
  }
  throw new MailaiError("auth_error", "device code expired (deadline exceeded)");
}

export async function runDeviceFlow(
  cfg: DeviceFlowConfig,
  display: (code: DeviceCodeResponse) => void,
): Promise<DeviceFlowResult> {
  const code = await startDeviceCode(cfg);
  display(code);
  const tokens = await pollForToken(cfg, code);
  return { code, tokens };
}
