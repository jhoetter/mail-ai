// Build an XOAUTH2 SASL initial-response string for IMAP/SMTP AUTH.
//
// Format (RFC 7628, but Gmail/Outlook just call it XOAUTH2):
//   user=<email>\x01auth=Bearer <accessToken>\x01\x01
// then base64-encode.
//
// Used by @mailai/imap-sync once we wire OAuth-backed accounts. Lives
// here so all of mail-ai's OAuth surface is in one package.

export function buildXoauth2(args: { email: string; accessToken: string }): string {
  const raw = `user=${args.email}\x01auth=Bearer ${args.accessToken}\x01\x01`;
  return Buffer.from(raw, "utf8").toString("base64");
}
