// SMTP submission via the user's provider, then IMAP APPEND-to-Sent
// so the message is visible to other clients (Outlook, Gmail web).
//
// IMAP APPEND is delegated back to the caller via the `appendToSent`
// callback so this package keeps its imapflow surface area zero — only
// `packages/imap-sync` may import imapflow per the architecture rules.

import nodemailer, { type Transporter } from "nodemailer";
import { MailaiError } from "@mailai/core";
import { composeMessage, type DraftSpec } from "@mailai/mime";

export interface SmtpConfig {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly auth:
    | { kind: "password"; user: string; pass: string }
    | { kind: "xoauth2"; user: string; accessToken: string };
}

export interface SendOutcome {
  readonly messageId: string;
  readonly raw: Buffer;
  readonly accepted: readonly string[];
  readonly rejected: readonly string[];
}

export class SmtpSender {
  private readonly transporter: Transporter;
  constructor(cfg: SmtpConfig) {
    this.transporter = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth:
        cfg.auth.kind === "password"
          ? { user: cfg.auth.user, pass: cfg.auth.pass }
          : { type: "OAuth2", user: cfg.auth.user, accessToken: cfg.auth.accessToken },
    });
  }

  async verify(): Promise<void> {
    try {
      await this.transporter.verify();
    } catch (err) {
      throw new MailaiError("smtp_error", err instanceof Error ? err.message : String(err), {
        cause: err,
      });
    }
  }

  async send(draft: DraftSpec): Promise<SendOutcome> {
    const composed = composeMessage(draft);
    try {
      const info = await this.transporter.sendMail({
        envelope: {
          from: draft.from,
          to: [...draft.to, ...(draft.cc ?? []), ...(draft.bcc ?? [])],
        },
        raw: composed.raw,
      });
      return {
        messageId: composed.messageId,
        raw: composed.raw,
        accepted: (info.accepted ?? []).map(String),
        rejected: (info.rejected ?? []).map(String),
      };
    } catch (err) {
      throw new MailaiError("smtp_error", err instanceof Error ? err.message : String(err), {
        cause: err,
      });
    }
  }
}
