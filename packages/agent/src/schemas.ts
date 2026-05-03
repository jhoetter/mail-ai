// Zod schemas for every CLI/MCP-exposed type. The CLI uses these for
// argv validation and the MCP tool layer uses them for input/output
// schema generation. The agent SDK uses them as runtime validators on
// every command payload before bus.dispatch().

import { z } from "zod";

export const AddressSchema = z.object({
  name: z.string().optional(),
  address: z.string().email(),
});

// References staged uploads in `draft_attachments`. The browser is
// responsible for `attachment:upload-init` → presigned PUT →
// `attachment:upload-finalise` before sending; `mail:send` /
// `mail:reply` only carry the `fileId` and the server hydrates the
// bytes from S3 at compose time. Base64 inlining was removed in the
// full-feature email overhaul because (a) it exceeds Postgres row
// size on multi-megabyte files and (b) it doesn't compose cleanly
// with the Graph `sendMail` raw-MIME path.
export const AttachmentRefSchema = z.object({
  fileId: z.string(),
});

export const DraftSchema = z.object({
  to: z.array(z.string().email()).min(1),
  cc: z.array(z.string().email()).optional(),
  bcc: z.array(z.string().email()).optional(),
  subject: z.string(),
  body: z.string(),
  inReplyTo: z.string().optional(),
  attachments: z.array(AttachmentRefSchema).optional(),
});

export const ThreadQuerySchema = z.object({
  status: z.enum(["open", "snoozed", "resolved", "archived"]).optional(),
  assignedTo: z.string().optional(),
  mailboxId: z.string().optional(),
  limit: z.number().int().min(1).max(500).default(50),
});

export const SearchSpecSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(200).default(50),
});

// RFC 5545 RRULE subset matching the CalendarProvider port. Kept
// narrow on purpose: the recurrence affordances Google Calendar's UI
// surfaces (daily/weekly/monthly/yearly + interval + until/count + on
// specific weekdays / month days) all serialize through these
// fields; custom RRULEs round-trip via the originating event's raw
// payload.
export const RecurrenceSchema = z.object({
  freq: z.enum(["DAILY", "WEEKLY", "MONTHLY", "YEARLY"]),
  interval: z.number().int().positive().optional(),
  count: z.number().int().positive().optional(),
  until: z.string().datetime().optional(),
  byday: z.array(z.enum(["MO", "TU", "WE", "TH", "FR", "SA", "SU"])).optional(),
  bymonthday: z.array(z.number().int().min(1).max(31)).optional(),
});

export const CommandPayloadSchema = z.discriminatedUnion("type", [
  // Mark every message in the provider thread read/unread. ThreadView
  // dispatches this on open (debounced); the handler walks the local
  // `oauth_messages` rows and applies provider-specific labels.
  z.object({
    type: z.literal("mail:mark-read"),
    payload: z.object({
      providerThreadId: z.string(),
      accountId: z.string().optional(),
    }),
  }),
  z.object({
    type: z.literal("mail:mark-unread"),
    payload: z.object({
      providerThreadId: z.string(),
      accountId: z.string().optional(),
    }),
  }),
  // Star toggle for a single message (Gmail STARRED label / Graph
  // single-value extended property). We star messages, not threads,
  // because that's the wire-level granularity providers expose.
  z.object({
    type: z.literal("mail:star"),
    payload: z.object({
      providerMessageId: z.string(),
      starred: z.boolean(),
      accountId: z.string().optional(),
    }),
  }),
  z.object({ type: z.literal("mail:archive"), payload: z.object({ threadId: z.string() }) }),
  z.object({
    type: z.literal("mail:reply"),
    payload: z.object({
      threadId: z.string(),
      body: z.string(),
      // Optional rich-text HTML body. When present, the message is sent
      // multipart/alternative so capable clients render the formatted
      // version while text/plain stays as the fallback.
      bodyHtml: z.string().optional(),
      accountId: z.string().optional(),
      attachments: z.array(AttachmentRefSchema).optional(),
      // Optional recipient overrides. By default `mail:reply` derives
      // To from the source message's From header (vanilla "Reply").
      // The web client passes explicit lists when the user has edited
      // the recipient row or chose "Reply all" — at that point the
      // server must honour the user's intent rather than re-deriving.
      to: z.array(z.string().email()).optional(),
      cc: z.array(z.string().email()).optional(),
      bcc: z.array(z.string().email()).optional(),
    }),
  }),
  // Forward semantics differ from reply: the original message is
  // attached as a `message/rfc822` part inside the multipart/mixed
  // envelope when `includeOriginalAsEml` is true (the default). The
  // composer pre-fills body with a quoted preview but the EML carries
  // the canonical bytes for downstream clients.
  z.object({
    type: z.literal("mail:forward"),
    payload: z.object({
      providerMessageId: z.string(),
      to: z.array(z.string().email()).min(1),
      cc: z.array(z.string().email()).optional(),
      bcc: z.array(z.string().email()).optional(),
      subject: z.string().optional(),
      body: z.string(),
      bodyHtml: z.string().optional(),
      attachments: z.array(AttachmentRefSchema).optional(),
      includeOriginalAsEml: z.boolean().optional(),
      accountId: z.string().optional(),
    }),
  }),
  z.object({
    type: z.literal("mail:send"),
    payload: DraftSchema.extend({
      bodyHtml: z.string().optional(),
      accountId: z.string().optional(),
      // Source draft. When present, `draft_attachments` rows bound to
      // this draft are mirrored into `oauth_attachments` and the
      // staging tree is cleaned up after a successful send.
      draftId: z.string().optional(),
    }),
  }),
  // Per-thread "show external images" toggle. Stored as a sender
  // allow-list so reopening a thread keeps the choice without
  // re-prompting (cookie-only for v1; promotes to DB later).
  z.object({
    type: z.literal("mail:allow-images"),
    payload: z.object({
      providerThreadId: z.string(),
      sender: z.string(),
    }),
  }),
  // Attachment lifecycle. Three commands mirror collaboration-ai's
  // "init → PUT → finalise" pattern. The browser owns the byte
  // transfer; the server only sees metadata + a presigned URL.
  z.object({
    type: z.literal("attachment:upload-init"),
    payload: z.object({
      filename: z.string().min(1),
      mime: z.string().min(1),
      sizeBytes: z.number().int().nonnegative().optional(),
      draftId: z.string().optional(),
    }),
  }),
  z.object({
    type: z.literal("attachment:upload-finalise"),
    payload: z.object({
      fileId: z.string(),
      objectKey: z.string(),
      filename: z.string(),
      mime: z.string(),
      sizeBytes: z.number().int().nonnegative(),
      draftId: z.string().optional(),
    }),
  }),
  z.object({
    type: z.literal("attachment:remove"),
    payload: z.object({ fileId: z.string() }),
  }),
  // Per-account email signature. HTML is the canonical representation
  // (edited with RichEditor in Settings); the plain-text mirror is
  // used for the text/plain part of multipart/alternative envelopes.
  z.object({
    type: z.literal("account:set-signature"),
    payload: z.object({
      accountId: z.string(),
      signatureHtml: z.string().nullable(),
      signatureText: z.string().nullable(),
    }),
  }),
  z.object({
    type: z.literal("thread:assign"),
    payload: z.object({ threadId: z.string(), assigneeId: z.string() }),
  }),
  z.object({
    type: z.literal("thread:set-status"),
    payload: z.object({
      threadId: z.string(),
      status: z.enum(["open", "snoozed", "resolved", "archived"]),
    }),
  }),
  z.object({
    type: z.literal("thread:add-tag"),
    payload: z.object({ threadId: z.string(), tag: z.string() }),
  }),
  z.object({
    type: z.literal("thread:remove-tag"),
    payload: z.object({ threadId: z.string(), tag: z.string() }),
  }),
  z.object({
    type: z.literal("comment:add"),
    payload: z.object({
      threadId: z.string(),
      text: z.string(),
      mentions: z.array(z.string()).optional(),
    }),
  }),
  // Per-user thread state (Phase 6). `until` is an ISO timestamp or
  // a relative shorthand the handler resolves ("today", "tomorrow",
  // "weekend", "next-week"). Keeping the parsing on the server side
  // means the CLI / agents don't need to know about user timezones.
  z.object({
    type: z.literal("thread:snooze"),
    payload: z.object({ providerThreadId: z.string(), until: z.string() }),
  }),
  z.object({
    type: z.literal("thread:unsnooze"),
    payload: z.object({ providerThreadId: z.string() }),
  }),
  z.object({
    type: z.literal("thread:mark-done"),
    payload: z.object({ providerThreadId: z.string() }),
  }),
  z.object({
    type: z.literal("thread:reopen"),
    payload: z.object({ providerThreadId: z.string() }),
  }),
  // Drafts (Phase 5). `id` is required for update/delete/send but
  // omitted on create — the handler returns the new id in its
  // mutation snapshot.
  z.object({
    type: z.literal("draft:create"),
    payload: z
      .object({
        accountId: z.string().optional(),
        replyToMessageId: z.string().optional(),
        providerThreadId: z.string().optional(),
        to: z.array(z.string()).optional(),
        cc: z.array(z.string()).optional(),
        bcc: z.array(z.string()).optional(),
        subject: z.string().optional(),
        bodyText: z.string().optional(),
        bodyHtml: z.string().optional(),
      })
      .passthrough(),
  }),
  z.object({
    type: z.literal("draft:update"),
    payload: z
      .object({
        id: z.string(),
        to: z.array(z.string()).optional(),
        cc: z.array(z.string()).optional(),
        bcc: z.array(z.string()).optional(),
        subject: z.string().optional(),
        bodyText: z.string().optional(),
        bodyHtml: z.string().optional(),
      })
      .passthrough(),
  }),
  z.object({
    type: z.literal("draft:delete"),
    payload: z.object({ id: z.string() }),
  }),
  z.object({
    type: z.literal("draft:send"),
    payload: z.object({ id: z.string(), requestReadReceipt: z.boolean().optional() }),
  }),
  // Calendar (Phases 7-8).
  z.object({
    type: z.literal("calendar:respond"),
    payload: z.object({
      icalUid: z.string().optional(),
      eventId: z.string().optional(),
      response: z.enum(["accepted", "declined", "tentative"]),
      comment: z.string().optional(),
    }),
  }),
  z.object({
    type: z.literal("calendar:create-event"),
    payload: z.object({
      calendarId: z.string(),
      summary: z.string(),
      description: z.string().optional(),
      location: z.string().optional(),
      startsAt: z.string(),
      endsAt: z.string(),
      allDay: z.boolean().optional(),
      attendees: z.array(z.string()).optional(),
      // Optional conferencing link to mint on the provider side and
      // embed in the outgoing iTIP invite. `gmeet` only validates on
      // google-mail accounts, `teams` only on outlook; the server
      // returns a `validation_error` otherwise.
      meeting: z.enum(["gmeet", "teams", "none"]).optional(),
      // IANA zone id (eg. "Europe/Berlin"). Adapters that advertise
      // capabilities.timeZones=true honor it; others ignore.
      timeZone: z.string().optional(),
      // RFC 5545-ish RRULE subset. Adapters that advertise
      // capabilities.recurrence=true serialize it for the upstream
      // API; the rest reject the call with a validation error.
      recurrence: RecurrenceSchema.optional(),
    }),
  }),
  z.object({
    type: z.literal("calendar:update-event"),
    payload: z.object({
      eventId: z.string(),
      summary: z.string().optional(),
      description: z.string().optional(),
      location: z.string().optional(),
      startsAt: z.string().optional(),
      endsAt: z.string().optional(),
      allDay: z.boolean().optional(),
      // Attendee deltas. The handler reads the existing list off the
      // event and merges before passing the patch to the adapter.
      attendeesAdd: z.array(z.string()).optional(),
      attendeesRemove: z.array(z.string()).optional(),
      meeting: z.enum(["gmeet", "teams", "none"]).optional(),
      // null = clear recurrence (turns a series into a single event);
      // an object = replace it.
      recurrence: RecurrenceSchema.nullable().optional(),
      timeZone: z.string().optional(),
      // Only relevant for events that belong to a series. Adapters
      // surface the supported subset via capabilities.editScopes; the
      // handler validates against that before dispatching.
      scope: z.enum(["single", "following", "series"]).optional(),
    }),
  }),
  z.object({
    type: z.literal("calendar:delete-event"),
    payload: z.object({
      eventId: z.string(),
      scope: z.enum(["single", "following", "series"]).optional(),
    }),
  }),
  z.object({
    type: z.literal("calendar:respond-from-ics"),
    payload: z.object({
      messageId: z.string(),
      attachmentId: z.string().optional(),
      response: z.enum(["accepted", "declined", "tentative"]),
    }),
  }),
  z.object({
    type: z.literal("mail:set-importance"),
    payload: z.object({
      providerMessageId: z.string(),
      important: z.boolean(),
      accountId: z.string().optional(),
    }),
  }),
  z.object({
    type: z.literal("mail:schedule-send"),
    payload: z.object({
      draftId: z.string(),
      sendAt: z.string().datetime(),
    }),
  }),
  z.object({
    type: z.literal("account:set-vacation"),
    payload: z.object({
      accountId: z.string(),
      enabled: z.boolean(),
      subject: z.string().nullable().optional(),
      message: z.string().nullable().optional(),
      startsAt: z.string().datetime().nullable().optional(),
      endsAt: z.string().datetime().nullable().optional(),
    }),
  }),
]);

export type ValidatedCommand = z.infer<typeof CommandPayloadSchema>;
