// Smoke tests for the standalone SSO handoff middleware.
//
// The contract under test is symmetric with hof-os'
// ``mint_subapp_jwt`` (Python, hof-os/packages/hof-components/modules/
// subapp-proxy/domain/shared/subapp_proxy.py): we hand-roll an HS256 JWT
// with the same fields hof-os emits and assert the verifier accepts it.
// If this test fails because the Python side started emitting different
// claims, fix BOTH sides at once — drift here breaks SSO across every
// subapp.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";

import { __testInternals } from "./sso.js";

const { verifyHandoffJwt } = __testInternals;

function b64url(input: string | Buffer): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf-8") : input;
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function makeToken(secret: string, claims: Record<string, unknown>): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify(claims));
  const sig = b64url(
    createHmac("sha256", Buffer.from(secret, "utf-8")).update(`${header}.${payload}`).digest(),
  );
  return `${header}.${payload}.${sig}`;
}

describe("SSO handoff verifier", () => {
  beforeEach(() => {
    delete process.env["HOF_SUBAPP_JWT_SECRET"];
    delete process.env["HOF_SUBAPP_JWT_SECRET_PREVIOUS"];
  });

  afterEach(() => {
    delete process.env["HOF_SUBAPP_JWT_SECRET"];
    delete process.env["HOF_SUBAPP_JWT_SECRET_PREVIOUS"];
  });

  it("accepts a JWT minted by hof-os' Python signer with the matching secret", () => {
    process.env["HOF_SUBAPP_JWT_SECRET"] = "shared-secret";
    const token = makeToken("shared-secret", {
      iss: "hof-os",
      aud: "mailai",
      sub: "user-1",
      tid: "tenant-x",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 60,
    });
    const claims = verifyHandoffJwt(token);
    expect(claims).not.toBeNull();
    expect(claims?.aud).toBe("mailai");
    expect(claims?.sub).toBe("user-1");
    expect(claims?.tid).toBe("tenant-x");
  });

  it("accepts the previous secret during rotation", () => {
    process.env["HOF_SUBAPP_JWT_SECRET"] = "new-secret";
    process.env["HOF_SUBAPP_JWT_SECRET_PREVIOUS"] = "old-secret";
    const oldToken = makeToken("old-secret", {
      aud: "mailai",
      sub: "user-1",
      tid: "tenant-x",
      exp: Math.floor(Date.now() / 1000) + 60,
    });
    expect(verifyHandoffJwt(oldToken)).not.toBeNull();
  });

  it("rejects tokens for the wrong audience", () => {
    process.env["HOF_SUBAPP_JWT_SECRET"] = "shared-secret";
    const token = makeToken("shared-secret", {
      aud: "collabai",
      sub: "user-1",
      tid: "tenant-x",
      exp: Math.floor(Date.now() / 1000) + 60,
    });
    expect(verifyHandoffJwt(token)).toBeNull();
  });

  it("rejects tokens with a tampered signature", () => {
    process.env["HOF_SUBAPP_JWT_SECRET"] = "shared-secret";
    const token = makeToken("shared-secret", {
      aud: "mailai",
      sub: "user-1",
      tid: "tenant-x",
      exp: Math.floor(Date.now() / 1000) + 60,
    });
    const [h, p, s] = token.split(".");
    const flipped = (s![0] === "A" ? "B" : "A") + s!.slice(1);
    expect(verifyHandoffJwt(`${h}.${p}.${flipped}`)).toBeNull();
  });

  it("rejects expired tokens", () => {
    process.env["HOF_SUBAPP_JWT_SECRET"] = "shared-secret";
    const token = makeToken("shared-secret", {
      aud: "mailai",
      sub: "user-1",
      tid: "tenant-x",
      exp: Math.floor(Date.now() / 1000) - 10,
    });
    expect(verifyHandoffJwt(token)).toBeNull();
  });

  it("rejects malformed tokens", () => {
    process.env["HOF_SUBAPP_JWT_SECRET"] = "shared-secret";
    expect(verifyHandoffJwt("not-a-jwt")).toBeNull();
    expect(verifyHandoffJwt("a.b")).toBeNull();
  });

  it("falls back to the dev secret when no env is set so local dev still SSOs", () => {
    delete process.env["HOF_SUBAPP_JWT_SECRET"];
    const token = makeToken("dev-only-not-for-prod-9c2f", {
      aud: "mailai",
      sub: "user-1",
      tid: "tenant-x",
      exp: Math.floor(Date.now() / 1000) + 60,
    });
    expect(verifyHandoffJwt(token)).not.toBeNull();
  });
});
