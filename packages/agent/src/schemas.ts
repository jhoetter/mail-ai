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
    payload: z.object({ threadId: z.string(), body: z.string(), accountId: z.string().optional() }),
  }),
  z.object({ type: z.literal("mail:send"), payload: DraftSchema.extend({ accountId: z.string().optional() }) }),
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
]);

export type ValidatedCommand = z.infer<typeof CommandPayloadSchema>;
