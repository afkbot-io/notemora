import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { z } from "zod";
import { attachmentSchema, date, message, request, threadSchema } from "./api";
import type { Project, Thread } from "./api";
import { Empty, Notice } from "./ui";

/** Ссылка Storybook восстанавливает только безопасный id истории, без исходных query-параметров. */
function sourceLink(thread: Thread) {
  if (!thread.context.url) return "";
  const url = new URL(thread.context.url);
  if (thread.context.surface === "storybook")
    url.searchParams.set("id", thread.context.pageKey);
  return url.href;
}

export function Screenshot({
  projectId,
  id,
}: {
  projectId: string;
  id: string;
}) {
  const [src, setSrc] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    let url = "";
    void fetch(`/api/v1/projects/${projectId}/attachments/${id}`, {
      credentials: "same-origin",
      signal: controller.signal,
      cache: "no-store",
      redirect: "error",
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("Снимок недоступен");
        const blob = await response.blob();
        if (!controller.signal.aborted) {
          url = URL.createObjectURL(blob);
          setSrc(url);
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(message(error));
      });
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [projectId, id]);
  return error ? (
    <Notice>{error}</Notice>
  ) : src ? (
    <a href={src} target="_blank" rel="noreferrer" className="screenshot">
      <img src={src} alt="Прикреплённый снимок интерфейса" />
    </a>
  ) : (
    <p className="muted" role="status">
      Загружаем снимок…
    </p>
  );
}

export function Discussions({
  projects,
  openProjects,
}: {
  projects: Project[];
  openProjects: () => void;
}) {
  const [projectId, setProjectId] = useState("");
  const [surface, setSurface] = useState("");
  const [search, setSearch] = useState("");
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const pagesLoaded = useRef(1);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [selected, setSelected] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState("");
  const drafts = useRef(
    new Map<
      string,
      {
        body: string;
        file: File | null;
        requestId: string;
        prepared: {
          requestId: string;
          body: string;
          attachmentIds: string[];
          captureState: "captured" | "none";
        } | null;
      }
    >(),
  );
  const [, renderDraft] = useState(0);
  const actualId = projects.some((p) => p.id === projectId)
    ? projectId
    : (projects[0]?.id ?? "");
  const key = actualId + ":" + selected;
  let current = drafts.current.get(key);
  if (!current) {
    current = {
      body: "",
      file: null,
      requestId: crypto.randomUUID(),
      prepared: null,
    };
    drafts.current.set(key, current);
  }
  const intent = current;
  const draft = intent.body,
    file = intent.file;
  function setDraft(value: string) {
    intent.body = value;
    intent.requestId = crypto.randomUUID();
    intent.prepared = null;
    renderDraft((value) => value + 1);
  }
  function setFile(value: File | null) {
    intent.file = value;
    intent.requestId = crypto.randomUUID();
    intent.prepared = null;
    renderDraft((value) => value + 1);
  }
  const latestRequest = useRef(0);
  const load = useCallback(
    async (signal?: AbortSignal, appendCursor?: string) => {
      if (!actualId) return;
      const sequence = ++latestRequest.current;
      setLoading(true);
      try {
        let cursor: string | null = appendCursor ?? null;
        const loaded: Thread[] = [];
        let count = 0;
        const wanted = appendCursor ? 1 : pagesLoaded.current;
        do {
          const query = new URLSearchParams({ search });
          if (surface) query.set("surface", surface);
          if (cursor) query.set("cursor", cursor);
          const data = await request(
            `/v1/projects/${actualId}/threads?${query}`,
            z.object({
              threads: z.array(threadSchema),
              nextCursor: z.string().nullable(),
            }),
            { signal },
          );
          loaded.push(...data.threads);
          cursor = data.nextCursor;
          count++;
        } while (cursor && count < wanted);
        if (sequence === latestRequest.current && !signal?.aborted) {
          setThreads((previous) =>
            appendCursor ? [...previous, ...loaded] : loaded,
          );
          setNextCursor(cursor);
          pagesLoaded.current = appendCursor ? pagesLoaded.current + 1 : count;
          if (!appendCursor)
            setSelected((value) =>
              loaded.some((thread) => thread.id === value)
                ? value
                : (loaded[0]?.id ?? ""),
            );
          setError("");
        }
      } catch (error) {
        if (!signal?.aborted && sequence === latestRequest.current)
          setError(message(error));
      } finally {
        if (!signal?.aborted && sequence === latestRequest.current)
          setLoading(false);
      }
    },
    [actualId, search, surface],
  );
  useEffect(() => {
    const controller = new AbortController();
    pagesLoaded.current = 1;
    setThreads([]);
    setNextCursor(null);
    setLoading(true);
    const timer = window.setTimeout(() => void load(controller.signal), 200);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [load]);
  useEffect(() => {
    const refresh = () => {
      if (!document.hidden && !busy && !loading) void load();
    };
    const interval = setInterval(refresh, 30000);
    window.addEventListener("focus", refresh);
    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", refresh);
    };
  }, [load, busy, loading]);
  const thread = threads.find((value) => value.id === selected);
  async function reply(event: FormEvent) {
    event.preventDefault();
    if (!thread || !draft.trim()) return;
    setBusy(true);
    setError("");
    ++latestRequest.current;
    try {
      const attachmentIds: string[] = [];
      if (!intent.prepared && file) {
        const form = new FormData();
        form.set("file", file);
        const upload = await request(
          `/v1/projects/${actualId}/attachments`,
          attachmentSchema,
          { method: "POST", body: form },
        );
        attachmentIds.push(upload.id);
      }
      if (!intent.prepared)
        intent.prepared = {
          requestId: intent.requestId,
          body: draft,
          attachmentIds,
          captureState: attachmentIds.length ? "captured" : "none",
        };
      await request(
        `/v1/projects/${actualId}/threads/${thread.id}/comments`,
        threadSchema,
        {
          method: "POST",
          body: intent.prepared,
        },
      );
      setDraft("");
      setFile(null);
      intent.requestId = crypto.randomUUID();
      intent.prepared = null;
      await load();
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
    }
  }
  async function remove(id: string) {
    setBusy(true);
    ++latestRequest.current;
    try {
      await request(`/v1/projects/${actualId}/comments/${id}`, z.undefined(), {
        method: "DELETE",
      });
      setConfirm("");
      await load();
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
    }
  }
  if (!projects.length)
    return (
      <Empty title="Нет проектов">
        <button className="primary" onClick={openProjects}>
          Открыть проекты
        </button>
      </Empty>
    );
  return (
    <>
      <div className="filters">
        <label className="sr-only" htmlFor="project-filter">
          Проект
        </label>
        <select
          id="project-filter"
          value={actualId}
          onChange={(event) => {
            setProjectId(event.target.value);
            setSelected("");
          }}
          disabled={busy}
        >
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
        <label className="sr-only" htmlFor="surface-filter">
          Поверхность
        </label>
        <select
          id="surface-filter"
          disabled={busy}
          value={surface}
          onChange={(event) => setSurface(event.target.value)}
        >
          <option value="">Все поверхности</option>
          <option value="app">Приложение</option>
          <option value="storybook">Storybook</option>
        </select>
        <input
          aria-label="Поиск обсуждений"
          disabled={busy}
          placeholder="Поиск"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <button disabled={loading || busy} onClick={() => void load()}>
          {loading ? "Загрузка…" : "Обновить"}
        </button>
      </div>
      {error && <Notice>{error}</Notice>}
      <div
        className={
          threads.length ? "review-layout" : "review-layout empty-review"
        }
      >
        <section className="thread-list" aria-label="Обсуждения">
          {threads.length ? (
            threads.map((value) => (
              <button
                key={value.id}
                className={
                  value.id === selected ? "thread-row selected" : "thread-row"
                }
                disabled={busy}
                onClick={() => {
                  setSelected(value.id);
                }}
              >
                <div className="thread-row-top">
                  <span className="badge">
                    {value.context.surface === "storybook"
                      ? "Storybook"
                      : "Приложение"}
                  </span>
                  <span>{value.comments.length}</span>
                </div>
                <strong>{value.context.pageTitle}</strong>
                <p>{value.comments[0]?.body}</p>
                <span className="muted small">{value.anchor.label}</span>
              </button>
            ))
          ) : (
            <Empty
              title={
                loading
                  ? "Загрузка…"
                  : search
                    ? "Ничего не найдено"
                    : "Нет обсуждений"
              }
            ></Empty>
          )}
          {nextCursor && (
            <button
              className="load-more"
              disabled={loading || busy}
              onClick={() => void load(undefined, nextCursor)}
            >
              Загрузить ещё
            </button>
          )}
        </section>
        <section className="thread-detail" aria-label="Переписка">
          {thread ? (
            <>
              <header className="detail-header">
                <span className="badge">
                  {thread.context.surface === "storybook"
                    ? "Storybook"
                    : "Приложение"}
                </span>
                <h2>{thread.context.pageTitle}</h2>
                <p>{thread.anchor.label}</p>
                <code>{thread.anchor.selector}</code>
                <div className="detail-meta">
                  <span>Сборка: {thread.context.build || "Не указана"}</span>
                  {thread.context.url && (
                    <a
                      href={sourceLink(thread)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Открыть страницу
                    </a>
                  )}
                </div>
              </header>
              <div className="messages">
                {thread.comments.map((comment) => (
                  <article className="comment" key={comment.id}>
                    <header>
                      <strong>{comment.author.name}</strong>
                      <time dateTime={comment.createdAt}>
                        {date(comment.createdAt)}
                      </time>
                    </header>
                    <p>{comment.body}</p>
                    {comment.attachments.map((item) => (
                      <Screenshot
                        key={item.id}
                        projectId={actualId}
                        id={item.id}
                      />
                    ))}
                    {!comment.attachments.length && (
                      <span className="muted small">
                        {comment.captureState === "failed"
                          ? "Автоматический снимок не получен"
                          : "Без нового снимка"}
                      </span>
                    )}
                    <footer>
                      <span className="muted small">
                        До {date(comment.expiresAt)}
                      </span>
                      {comment.canDelete &&
                        (confirm === comment.id ? (
                          <div className="inline-actions">
                            <button
                              className="danger"
                              disabled={busy}
                              onClick={() => void remove(comment.id)}
                            >
                              Удалить сообщение
                            </button>
                            <button onClick={() => setConfirm("")}>
                              Отмена
                            </button>
                          </div>
                        ) : (
                          <button
                            className="text-button"
                            disabled={busy}
                            onClick={() => setConfirm(comment.id)}
                          >
                            Удалить
                          </button>
                        ))}
                    </footer>
                  </article>
                ))}
              </div>
              <form
                className="reply-form"
                onSubmit={(event) => void reply(event)}
              >
                <label htmlFor="reply-body">Ответить в обсуждении</label>
                <textarea
                  id="reply-body"
                  value={draft}
                  onChange={(event) => {
                    setDraft(event.target.value);
                    intent.requestId = crypto.randomUUID();
                    intent.prepared = null;
                  }}
                  maxLength={4000}
                  rows={3}
                  placeholder="Ответ"
                  required
                  disabled={busy}
                />
                <label className="file-label">
                  Добавить снимок
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    disabled={busy}
                    onChange={(event) => {
                      setFile(event.target.files?.[0] ?? null);
                      intent.requestId = crypto.randomUUID();
                      intent.prepared = null;
                    }}
                  />
                </label>
                {file && <span className="small muted">{file.name}</span>}
                <button className="primary" disabled={busy || !draft.trim()}>
                  {busy ? "Отправка…" : "Отправить ответ"}
                </button>
              </form>
            </>
          ) : threads.length ? (
            <Empty title="Выберите обсуждение" />
          ) : null}
        </section>
      </div>
    </>
  );
}
