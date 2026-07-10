import { z } from "zod";

export const messageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("join"),
    alias: z.string(),
  }),

  z.object({
    type: z.literal("heartbeat"),
  }),

  z.object({
    type: z.literal("offer"),
    to: z.string(),
    data: z.any(),
  }),

  z.object({
    type: z.literal("answer"),
    to: z.string(),
    data: z.any(),
  }),

  z.object({
    type: z.literal("candidate"),
    to: z.string(),
    data: z.any(),
  }),

  // --- transfer handshake ---
  z.object({
    type: z.literal("transfer-invite"),
    to: z.string(),
    file: z
      .object({
        name: z.string(),
        size: z.number(),
        mimeType: z.string(),
      })
      .optional(),
  }),

  z.object({
    type: z.literal("transfer-accept"),
    to: z.string(),
  }),

  z.object({
    type: z.literal("transfer-decline"),
    to: z.string(),
  }),
]);
