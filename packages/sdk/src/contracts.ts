import { z } from "zod";

export const attachmentSchema = z.object({
  id: z.string(),
  width: z.number(),
  height: z.number(),
  size: z.number(),
  contentType: z.literal("image/webp"),
  context: z.record(z.string(), z.unknown()),
});
export const contextSchema = z.object({
  surface: z.enum(["app", "storybook"]),
  pageKey: z.string(),
  pageTitle: z.string(),
  build: z.string(),
  viewport: z.object({ width: z.number(), height: z.number() }),
  locale: z.string(),
  url: z.string().optional(),
  commitSha: z.string().optional(),
});
export const anchorSchema = z.object({
  key: z.string(),
  selector: z.string(),
  label: z.string(),
  x: z.number().finite().min(0).max(1),
  y: z.number().finite().min(0).max(1),
});
export const commentSchema = z.object({
  id: z.string(),
  body: z.string(),
  author: z.object({ id: z.string(), name: z.string() }),
  createdAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
  canDelete: z.boolean(),
  captureState: z.enum(["none", "captured", "failed"]),
  attachments: z.array(attachmentSchema),
});
export const threadSchema = z.object({
  id: z.string(),
  context: contextSchema,
  anchor: anchorSchema,
  comments: z.array(commentSchema),
});
export const pageSchema = z.object({
  threads: z.array(threadSchema),
  nextCursor: z.string().nullable(),
});
export const projectSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.enum(["owner", "moderator", "member"]),
  origins: z.array(z.string()),
});
export type ReviewThread = z.infer<typeof threadSchema>;
export type ReviewAttachment = z.infer<typeof attachmentSchema>;
export type ReviewContext = z.infer<typeof contextSchema>;
export type ReviewAnchor = z.infer<typeof anchorSchema>;
export type ReviewProject = z.infer<typeof projectSchema>;
