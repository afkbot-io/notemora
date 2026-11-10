import { z } from "zod";
import { attachmentSchema, pageSchema, threadSchema } from "./contracts";
import type { ReviewAnchor, ReviewContext, ReviewThread } from "./contracts";

export class ReviewError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Короткий bearer-доступ хранится вызывающим только в памяти. Пациентские cookies не отправляются. */
export class ReviewClient {
  constructor(
    private base: string,
    private project: string,
    private token: () => string | undefined,
  ) {}
  async request<T>(
    path: string,
    schema: z.ZodType<T>,
    method = "GET",
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const form = body instanceof FormData;
    const token = this.token();
    if (!token) throw new ReviewError(401, "Войдите в Notemora");
    let response: Response;
    try {
      response = await fetch(
        `${this.base}/api/v1/projects/${encodeURIComponent(this.project)}${path}`,
        {
          method,
          credentials: "omit",
          redirect: "error",
          cache: "no-store",
          signal,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
            ...(body && !form ? { "Content-Type": "application/json" } : {}),
          },
          body: body ? (form ? body : JSON.stringify(body)) : undefined,
        },
      );
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new ReviewError(
        0,
        "Нет связи с Notemora. Черновик сохранён; повторите отправку.",
      );
    }
    if (!response.ok) {
      const parsed = z
        .object({ detail: z.unknown() })
        .safeParse(await response.json().catch(() => null));
      throw new ReviewError(
        response.status,
        parsed.success && typeof parsed.data.detail === "string"
          ? parsed.data.detail
          : "Не удалось выполнить действие",
      );
    }
    return schema.parse(
      response.status === 204 ? undefined : await response.json(),
    );
  }
  async list(
    surface: "app" | "storybook",
    signal?: AbortSignal,
  ): Promise<ReviewThread[]> {
    const threads: ReviewThread[] = [];
    const cursors = new Set<string>();
    let cursor: string | null = null;
    do {
      const query = new URLSearchParams({ surface });
      if (cursor) query.set("cursor", cursor);
      const page = await this.request(
        `/threads?${query}`,
        pageSchema,
        "GET",
        undefined,
        signal,
      );
      threads.push(...page.threads);
      cursor = page.nextCursor;
      if (cursor && (cursors.has(cursor) || cursors.size >= 99))
        throw new ReviewError(0, "Слишком большой список обсуждений");
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return threads;
  }
  create(
    input: MessageInput & { context: ReviewContext; anchor: ReviewAnchor },
    signal?: AbortSignal,
  ) {
    return this.request("/threads", threadSchema, "POST", input, signal);
  }
  reply(id: string, input: MessageInput, signal?: AbortSignal) {
    return this.request(
      `/threads/${encodeURIComponent(id)}/comments`,
      threadSchema,
      "POST",
      input,
      signal,
    );
  }
  remove(id: string, signal?: AbortSignal) {
    return this.request(
      `/comments/${encodeURIComponent(id)}`,
      z.undefined(),
      "DELETE",
      undefined,
      signal,
    );
  }
  upload(blob: Blob, context: Record<string, unknown>, signal?: AbortSignal) {
    const form = new FormData();
    form.set("file", blob, "review.png");
    form.set("context", JSON.stringify(context));
    return this.request("/attachments", attachmentSchema, "POST", form, signal);
  }
  async image(id: string, signal?: AbortSignal): Promise<Blob> {
    const token = this.token();
    if (!token) throw new ReviewError(401, "Войдите в Notemora");
    const response = await fetch(
      `${this.base}/api/v1/projects/${encodeURIComponent(this.project)}/attachments/${encodeURIComponent(id)}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        credentials: "omit",
        redirect: "error",
        signal,
      },
    );
    if (!response.ok)
      throw new ReviewError(response.status, "Снимок недоступен");
    return response.blob();
  }
}

export interface MessageInput {
  requestId: string;
  body: string;
  attachmentIds: string[];
  captureState: "captured" | "failed" | "none";
}
