// Schemas describing what every CLI subcommand prints in `--json`
// mode. The Phase-4 validation suite asserts each command's stdout
// against the matching schema so the CLI stays scriptable.

import { z } from "zod";

export const MutationOutputSchema = z.object({
  id: z.string(),
  status: z.enum(["applied", "failed"]),
  command: z.object({
    type: z.string(),
    actorId: z.string(),
    timestamp: z.number(),
  }),
  createdAt: z.number(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});

export const WhoamiOutputSchema = z.object({
  userId: z.string(),
  tenantId: z.string(),
  displayName: z.string(),
});

export const ApplyResultOutputSchema = z.object({
  ok: z.boolean(),
  mutation: MutationOutputSchema,
});

export const ErrorOutputSchema = z.object({
  error: z.string(),
  message: z.string(),
});
