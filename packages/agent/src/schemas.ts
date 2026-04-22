// Zod schemas for every CLI/MCP-exposed type. The CLI uses these for
// argv validation and the MCP tool layer uses them for input/output
// schema generation. The agent SDK uses them as runtime validators on
// every command payload before bus.dispatch().

import { z } from "zod";

export const AddressSchema = z.object({
  name: z.string().optional(),
  address: z.string().email(),
});

export const DraftSchema = z.object({
  to: z.array(z.string().email()).min(1),
  cc: z.array(z.string().email()).optional(),
  bcc: z.array(z.string().email()).optional(),
  subject: z.string(),
  body: z.string(),
  inReplyTo: z.string().optional(),
  attachments: z
    .array(
      z.object({
        filename: z.string(),
        contentType: z.string(),
        contentBase64: z.string(),
      }),
    )
    .optional(),
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

export const CommandPayloadSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("mail:mark-read"), payload: z.object({ threadId: z.string() }) }),
  z.object({ type: z.literal("mail:mark-unread"), payload: z.object({ threadId: z.string() }) }),
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
    }),
  }),
  z.object({
    type: z.literal("mail:send"),
    payload: DraftSchema.extend({
      bodyHtml: z.string().optional(),
      accountId: z.string().optional(),
    }),
  }),
  z.object({ type: z.literal("thread:assign"), payload: z.object({ threadId: z.string(), assigneeId: z.string() }) }),
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
    payload: z.object({ id: z.string() }),
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
    }),
  }),
  z.object({
    type: z.literal("calendar:delete-event"),
    payload: z.object({ eventId: z.string() }),
  }),
]);

export type ValidatedCommand = z.infer<typeof CommandPayloadSchema>;
