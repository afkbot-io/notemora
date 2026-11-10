import { z } from "zod";

export const userSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  active: z.boolean(),
  owner: z.boolean(),
  state: z.enum(["active", "invited", "disabled"]),
});
export const meSchema = z.object({ user: userSchema, csrfToken: z.string() });
export const projectSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.enum(["owner", "moderator", "member"]),
  origins: z.array(z.string()),
});
export const tokenSchema = z.object({
  id: z.string(),
  name: z.string(),
  projectIds: z.array(z.string()),
  scopes: z.array(z.string()),
  createdAt: z.string(),
  expiresAt: z.string(),
  lastUsedAt: z.string().nullable(),
  revoked: z.boolean(),
});
export const attachmentSchema = z.object({
  id: z.string(),
  width: z.number(),
  height: z.number(),
  size: z.number(),
  contentType: z.string(),
  context: z.record(z.string(), z.unknown()),
});
export const threadSchema = z.object({
  id: z.string(),
  context: z.object({
    pageTitle: z.string(),
    pageKey: z.string(),
    surface: z.string(),
    build: z.string(),
    url: z.string().optional(),
  }),
  anchor: z.object({ label: z.string(), selector: z.string() }),
  comments: z.array(
    z.object({
      id: z.string(),
      body: z.string(),
      author: z.object({ name: z.string(), id: z.string() }),
      createdAt: z.string(),
      expiresAt: z.string(),
      canDelete: z.boolean(),
      captureState: z.string(),
      attachments: z.array(attachmentSchema),
    }),
  ),
});
export type Me = z.infer<typeof meSchema>;
export type Project = z.infer<typeof projectSchema>;
export type Thread = z.infer<typeof threadSchema>;
export type User = z.infer<typeof userSchema>;
export type Token = z.infer<typeof tokenSchema>;

let csrf = "";
export function setCsrf(value: string) {
  csrf = value;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Запросы кабинета используют HttpOnly cookie и отдельный CSRF; результаты проверяются схемой. */
export async function request<T>(
  path: string,
  schema: z.ZodType<T>,
  options: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const body = options.body;
  const form = body instanceof FormData;
  const response = await fetch("/api" + path, {
    method: options.method ?? "GET",
    credentials: "same-origin",
    redirect: "error",
    cache: "no-store",
    signal: options.signal,
    headers: {
      Accept: "application/json",
      "X-CSRF-Token": csrf,
      ...(options.body && !form ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? (form ? body : JSON.stringify(body)) : undefined,
  });
  if (!response.ok) {
    const parsed = z
      .object({ detail: z.unknown() })
      .safeParse(await response.json().catch(() => null));
    const detail =
      parsed.success && typeof parsed.data.detail === "string"
        ? parsed.data.detail
        : "Проверьте поля и повторите действие";
    throw new ApiError(response.status, detail);
  }
  return schema.parse(
    response.status === 204 ? undefined : await response.json(),
  );
}

export const message = (error: unknown) =>
  error instanceof Error ? error.message : "Не удалось выполнить действие";
export const date = (value: string) =>
  new Date(value).toLocaleString("ru-RU", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
