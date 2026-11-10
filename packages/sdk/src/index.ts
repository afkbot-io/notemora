import styles from "./widget.css?inline";
import {
  anchorFor,
  anchorTarget,
  locate,
  safePageUrl,
  visibleRect,
} from "./anchors";
import { createHighlighter } from "./highlight";
import { signIn } from "./authorization";
import type { WidgetSession } from "./authorization";
import { ReviewClient, ReviewError } from "./client";
import type { MessageInput } from "./client";
import { capture } from "./capture";
import { placeToolbar } from "./toolbar";
import type { Capture } from "./capture";
import type { ReviewAnchor, ReviewContext, ReviewThread } from "./contracts";

export { ReviewClient, ReviewError } from "./client";
export { createProof } from "./authorization";
export { safePageUrl } from "./anchors";
export * from "./contracts";

export interface ReviewOptions {
  serviceUrl: string;
  projectId: string;
  surface: "app" | "storybook";
  build?: string;
  commitSha?: string;
  page?: () => { key: string; title: string };
  screenshots?: boolean;
  /** Скрыть локальную панель кнопок, если команды предоставляет хост (Storybook manager). */
  toolbar?: boolean;
}
export interface ReviewWidget {
  destroy(): void;
  open(): void;
  signIn(): Promise<void>;
  toggle(): void;
  pick(): void;
  setEnabled(enabled: boolean): void;
  /** Перечитывает логический экран SPA без повторного входа и без потери черновиков. */
  refreshContext(): void;
}
interface Draft {
  body: string;
  requestId: string;
  shot?: Promise<Capture | null>;
  uploaded?: string[];
  prepared?: MessageInput;
}
interface Selection {
  anchor: ReviewAnchor;
  context: ReviewContext;
  threadId?: string;
}

const element = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text = "",
  className = "",
) => {
  const node = document.createElement(tag);
  node.textContent = text;
  node.className = className;
  return node;
};
const action = (text: string, callback: () => void, className = "") => {
  const node = element("button", text, className);
  node.type = "button";
  node.addEventListener("click", callback);
  return node;
};
const iconPaths = {
  comment:
    "M19 14a3 3 0 0 1-3 3H9l-5 4V6a3 3 0 0 1 3-3h9a3 3 0 0 1 3 3Z M8 8h7 M8 12h5",
  target:
    "M8 3H4a1 1 0 0 0-1 1v4 M16 3h4a1 1 0 0 1 1 1v4 M21 16v4a1 1 0 0 1-1 1h-4 M8 21H4a1 1 0 0 1-1-1v-4 M12 8v8 M8 12h8",
  close: "m6 6 12 12 M18 6 6 18",
  back: "m10 5-7 7 7 7 M3 12h18",
  logout: "M9 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4 M13 8l4 4-4 4 M8 12h13",
};
const icon = (name: keyof typeof iconPaths) => {
  const node = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  node.setAttribute("viewBox", "0 0 24 24");
  node.setAttribute("fill", "none");
  node.setAttribute("stroke", "currentColor");
  node.setAttribute("stroke-width", "1.8");
  node.setAttribute("stroke-linecap", "round");
  node.setAttribute("stroke-linejoin", "round");
  node.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(node.namespaceURI, "path");
  path.setAttribute("d", iconPaths[name]);
  node.append(path);
  return node;
};

/** Монтирует изолированный виджет. destroy отменяет HTTP, наблюдатели, таймеры, popup и освобождает blob URL. */
export function initReview(options: ReviewOptions): ReviewWidget {
  const service = new URL(options.serviceUrl);
  if (
    service.pathname !== "/" ||
    service.search ||
    service.hash ||
    service.username ||
    (service.protocol !== "https:" &&
      !(
        service.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(service.hostname)
      ))
  )
    throw new Error("Укажите HTTPS origin Notemora либо локальный loopback");
  if (document.querySelector("[data-review-widget]"))
    throw new Error("Виджет Notemora уже подключён");
  const controller = new AbortController();
  const { signal } = controller;
  const host = element("div");
  host.setAttribute("data-review-widget", "");
  host.style.cssText =
    "position:fixed;inset:0;pointer-events:none;z-index:2147483600;";
  const shadow = host.attachShadow({ mode: "open" });
  const sheet = element("style", styles);
  const ui = element("div");
  const geometry = element("div", "", "geometry");
  shadow.append(sheet, geometry, ui);
  const highlighter = createHighlighter(shadow);
  document.body.append(host);
  let enabled = true;
  let session: WidgetSession | undefined;
  let draftOwner = "";
  let active = false,
    panel = false,
    picking = false,
    busy = false,
    loading = false,
    destroyed = false,
    frame = 0,
    revision = 0,
    allPages = false,
    search = "",
    error = "",
    confirmation = "";
  let threads: ReviewThread[] = [];
  let selected: Selection | undefined;
  let swallowClickUntil = 0;
  let highlightFrame = 0;
  let pointerPoint: { x: number; y: number } | undefined;
  let focusedTarget: Element | undefined;
  let reveal: { key: string; pageKey: string; keyboard: boolean } | undefined;
  let revealTimer: ReturnType<typeof setTimeout> | undefined;
  let pageKey = context().pageKey;
  const drafts = new Map<string, Draft>();
  const blobUrls = new Map<string, string>();
  const client = new ReviewClient(
    service.origin,
    options.projectId,
    () => session?.accessToken,
  );
  function context(): ReviewContext {
    const provided = options.page?.();
    const storyId = new URL(location.href).searchParams.get("id");
    return {
      surface: options.surface,
      pageKey: (
        provided?.key ??
        (options.surface === "storybook" && storyId
          ? storyId
          : location.pathname)
      ).slice(0, 300),
      pageTitle:
        (provided?.title ?? document.title ?? "Страница").slice(0, 300) ||
        "Страница",
      build: options.build ?? "",
      commitSha: options.commitSha ?? "",
      viewport: { width: innerWidth, height: innerHeight },
      locale: document.documentElement.lang || "ru",
      url: safePageUrl(location.href),
    };
  }
  function currentKey() {
    return selected
      ? selected.context.pageKey + "\n" + selected.anchor.key
      : "";
  }
  function draft() {
    const key = currentKey();
    let value = drafts.get(key);
    if (!value) {
      value = { body: "", requestId: crypto.randomUUID() };
      drafts.set(key, value);
    }
    return value;
  }
  function live() {
    return threads
      .map((thread) => ({
        ...thread,
        comments: thread.comments.filter(
          (comment) => Date.parse(comment.expiresAt) > Date.now(),
        ),
      }))
      .filter((thread) => thread.comments.length);
  }
  function failure(value: unknown) {
    if (signal.aborted) return;
    error = value instanceof Error ? value.message : "Действие не выполнено";
    if (value instanceof ReviewError && value.status === 401) {
      session = undefined;
      threads = [];
      clearImages();
    }
    render();
  }
  function clearImages() {
    for (const url of blobUrls.values()) URL.revokeObjectURL(url);
    blobUrls.clear();
  }
  async function load() {
    if (!enabled || !session || busy || destroyed) return;
    const current = ++revision;
    loading = true;
    render();
    try {
      const data = await client.list(options.surface, signal);
      if (current !== revision || destroyed) return;
      threads = data;
      if (selected) {
        const found = data.find(
          (thread) =>
            thread.context.pageKey === selected?.context.pageKey &&
            thread.anchor.key === selected?.anchor.key,
        );
        if (found) selected.threadId = found.id;
      }
      error = "";
    } catch (value) {
      if (current === revision) failure(value);
    } finally {
      if (current === revision && !destroyed) {
        loading = false;
        render();
      }
    }
  }
  async function login() {
    if (busy) return;
    busy = true;
    error = "";
    render();
    try {
      const next = await signIn(service.origin, options.projectId, signal);
      if (draftOwner && draftOwner !== next.user.id) drafts.clear();
      draftOwner = next.user.id;
      session = next;
    } catch (value) {
      failure(value);
    } finally {
      busy = false;
      if (!destroyed) {
        render();
        if (session) await load();
      }
    }
  }
  async function logout() {
    if (busy || !session) return;
    busy = true;
    try {
      const response = await fetch(
        new URL("/api/auth/widget-session", service.origin),
        {
          method: "DELETE",
          credentials: "omit",
          headers: { Authorization: `Bearer ${session.accessToken}` },
          signal,
        },
      );
      if (!response.ok && response.status !== 401)
        throw new Error("Не удалось завершить сессию. Повторите.");
      session = undefined;
      threads = [];
      drafts.clear();
      draftOwner = "";
      selected = undefined;
      clearImages();
    } catch (value) {
      failure(value);
    } finally {
      busy = false;
      render();
    }
  }
  function beginCapture(value: Draft, anchor: ReviewAnchor) {
    if (!value.shot && options.screenshots !== false)
      value.shot = capture(
        anchor,
        selected?.context.pageKey === context().pageKey,
      ).catch(() => null);
  }
  function choose(selection: Selection) {
    pageKey = context().pageKey;
    selected = selection;
    panel = true;
    picking = false;
    error = "";
    beginCapture(draft(), selection.anchor);
    render();
    shadow.querySelector("textarea")?.focus();
  }
  async function send() {
    if (!selected || busy || !draft().body.trim()) return;
    const selection = selected;
    const value = draft();
    const intentKey = currentKey();
    busy = true;
    ++revision;
    error = "";
    loading = false;
    render();
    try {
      if (!value.prepared) {
        beginCapture(value, selection.anchor);
        const shot = await value.shot;
        if (shot && !value.uploaded) {
          const file = await client.upload(shot.blob, shot.context, signal);
          value.uploaded = [file.id];
        }
        value.prepared = {
          body: value.body,
          requestId: value.requestId,
          attachmentIds: value.uploaded ?? [],
          captureState: value.uploaded?.length
            ? "captured"
            : options.screenshots === false
              ? "none"
              : "failed",
        };
      }
      const result = selection.threadId
        ? await client.reply(selection.threadId, value.prepared, signal)
        : await client.create(
            {
              ...value.prepared,
              context: selection.context,
              anchor: selection.anchor,
            },
            signal,
          );
      threads = [
        ...threads.filter((thread) => thread.id !== result.id),
        result,
      ];
      selected =
        selection.context.pageKey === context().pageKey
          ? { ...selection, threadId: result.id }
          : undefined;
      drafts.delete(intentKey);
    } catch (value) {
      failure(value);
    } finally {
      busy = false;
      render();
    }
  }
  async function remove(id: string) {
    if (busy) return;
    busy = true;
    ++revision;
    try {
      await client.remove(id, signal);
      threads = threads
        .map((thread) => ({
          ...thread,
          comments: thread.comments.filter((comment) => comment.id !== id),
        }))
        .filter((thread) => thread.comments.length);
      confirmation = "";
      if (
        selected?.threadId &&
        !threads.some((thread) => thread.id === selected?.threadId)
      )
        selected = undefined;
      error = "";
    } catch (value) {
      failure(value);
    } finally {
      busy = false;
      render();
    }
  }
  function showBlock() {
    if (!selected) return;
    if (selected.context.pageKey !== context().pageKey) {
      error = "Откройте исходную страницу: " + selected.context.pageTitle;
      render();
      return;
    }
    const node = locate(selected.anchor);
    if (!node) {
      error = "Блок не найден в этой версии. Исходный снимок сохранён.";
      render();
      return;
    }
    if (
      node.closest('[hidden],[inert],[aria-hidden="true"]') ||
      !node.getClientRects().length ||
      getComputedStyle(node).visibility === "hidden"
    ) {
      error = "Блок сейчас скрыт на странице.";
      render();
      return;
    }
    cancelReveal();
    reveal = {
      key: currentKey(),
      pageKey: context().pageKey,
      keyboard: shadow.activeElement?.matches(":focus-visible") ?? false,
    };
    panel = false;
    picking = false;
    error = "";
    render();
    node.scrollIntoView({
      block: "center",
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "instant"
        : "smooth",
    });
    revealTimer = setTimeout(() => finishReveal(), 3000);
  }
  function cancelReveal() {
    if (revealTimer !== undefined) clearTimeout(revealTimer);
    revealTimer = undefined;
    reveal = undefined;
  }
  function finishReveal(keyboard = reveal?.keyboard) {
    const previous = reveal;
    cancelReveal();
    queueHighlight();
    if (
      !previous ||
      destroyed ||
      !enabled ||
      !active ||
      picking ||
      previous.key !== currentKey() ||
      previous.pageKey !== context().pageKey
    )
      return;
    panel = true;
    render();
    if (keyboard && document.activeElement === document.body)
      shadow
        .querySelector<HTMLButtonElement>('[data-focus="show-block"]')
        ?.focus({ preventScroll: true });
  }
  function queueHighlight() {
    if (!highlightFrame && !destroyed)
      highlightFrame = requestAnimationFrame(drawHighlight);
  }
  function clearPointer() {
    if (!pointerPoint && !focusedTarget) return;
    pointerPoint = undefined;
    focusedTarget = undefined;
    queueHighlight();
  }
  function drawHighlight() {
    if (highlightFrame) cancelAnimationFrame(highlightFrame);
    highlightFrame = 0;
    if (!enabled || !active || !session) return highlighter.hide();
    if (picking) {
      const hit = pointerPoint
        ? document.elementFromPoint(pointerPoint.x, pointerPoint.y)
        : focusedTarget;
      if (hit && !hit.closest("[data-review-widget]"))
        return highlighter.show(anchorTarget(hit), "pick");
    } else if (selected && selected.context.pageKey === context().pageKey) {
      const node = locate(selected.anchor);
      if (node) return highlighter.show(node, reveal ? "reveal" : "selected");
    }
    highlighter.hide();
  }
  function pointerMove(event: PointerEvent) {
    if (!enabled || !picking || busy || inside(event)) return clearPointer();
    pointerPoint = { x: event.clientX, y: event.clientY };
    focusedTarget = undefined;
    queueHighlight();
  }
  function focusTarget(event: FocusEvent) {
    if (
      !enabled ||
      !picking ||
      inside(event) ||
      !(event.target instanceof Element)
    )
      return;
    focusedTarget = event.target;
    pointerPoint = undefined;
    queueHighlight();
  }
  function pointerOut(event: PointerEvent) {
    if (!event.relatedTarget) clearPointer();
  }
  function queueGeometry() {
    if (!frame && !destroyed) frame = requestAnimationFrame(drawGeometry);
  }
  function positionToolbar() {
    if (!enabled || active) return;
    const toolbar = shadow.querySelector<HTMLElement>(".toolbar");
    if (!toolbar) return;
    toolbar.style.top = "";
    const top = Number.parseFloat(getComputedStyle(toolbar).top) || 12;
    const bounds = toolbar.getBoundingClientRect();
    const actions = Array.from(
      document.querySelectorAll(
        'button,a[href],input,textarea,select,[role="button"]',
      ),
    )
      .map(visibleRect)
      .filter((rect) => rect !== null);
    const position = placeToolbar(
      bounds,
      { width: innerWidth, height: innerHeight },
      top,
      actions,
    );
    toolbar.style.left = `${position.left}px`;
    toolbar.style.right = "auto";
    toolbar.style.top = `${position.top}px`;
  }
  function drawGeometry() {
    frame = 0;
    geometry.replaceChildren();
    positionToolbar();
    drawHighlight();
    if (!enabled || !active || !session) return;
    const pageKey = context().pageKey;
    for (const thread of live().filter(
      (thread) => thread.context.pageKey === pageKey,
    )) {
      const node = locate(thread.anchor);
      const rect = node && visibleRect(node);
      if (!rect) continue;
      const outline = element("div", "", "outline");
      outline.style.cssText = `left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;`;
      const pin = action(
        String(thread.comments.length),
        () =>
          choose({
            anchor: thread.anchor,
            context: thread.context,
            threadId: thread.id,
          }),
        "pin",
      );
      pin.title = "Открыть обсуждение: " + thread.anchor.label;
      pin.setAttribute("aria-label", pin.title);
      pin.style.cssText = `left:${Math.max(4, Math.min(innerWidth - 36, rect.left + rect.width - 15))}px;top:${Math.max(4, rect.top - 15)}px;`;
      geometry.append(outline, pin);
    }
  }
  function image(id: string) {
    const node = element("img");
    node.alt = "Снимок интерфейса";
    const cached = blobUrls.get(id);
    if (cached) node.src = cached;
    else
      void client
        .image(id, signal)
        .then((blob) => {
          if (destroyed) return;
          const previous = blobUrls.get(id);
          const url = previous ?? URL.createObjectURL(blob);
          if (!previous) blobUrls.set(id, url);
          node.src = url;
        })
        .catch(() => {
          node.replaceWith(element("span", "Снимок недоступен", "muted"));
        });
    return node;
  }
  function render() {
    if (destroyed) return;
    if (
      reveal &&
      (!enabled ||
        !active ||
        picking ||
        panel ||
        reveal.key !== currentKey() ||
        reveal.pageKey !== context().pageKey)
    )
      cancelReveal();
    if (!picking) clearPointer();
    host.hidden = !enabled;
    if (!enabled) {
      ui.replaceChildren();
      geometry.replaceChildren();
      highlighter.hide();
      return;
    }
    const focused = shadow.activeElement;
    const focusName =
      focused instanceof HTMLElement ? focused.dataset.focus : undefined;
    const selectionStart =
      focused instanceof HTMLTextAreaElement ||
      focused instanceof HTMLInputElement
        ? focused.selectionStart
        : null;
    ui.replaceChildren();
    const toolbar = element("div", "", "toolbar");
    toolbar.setAttribute("role", "toolbar");
    toolbar.setAttribute("aria-label", "Режим комментариев");
    const commentsLabel =
      "Комментарии" +
      (session
        ? " · " +
          live().reduce((count, thread) => count + thread.comments.length, 0)
        : "");
    const commentsButton = action(
      "Комментарии",
      () => {
        active = !active;
        panel = active;
        picking = false;
        render();
      },
      active && !picking ? "primary" : "",
    );
    commentsButton.prepend(icon("comment"));
    commentsButton.setAttribute("aria-label", commentsLabel);
    commentsButton.setAttribute("aria-pressed", String(active));
    commentsButton.setAttribute("aria-expanded", String(panel && !picking));
    if (session)
      commentsButton.append(
        element(
          "span",
          String(
            live().reduce((count, thread) => count + thread.comments.length, 0),
          ),
          "count",
        ),
      );
    toolbar.append(commentsButton);
    if (active && session) {
      const picker = action(
        picking ? "Отменить выбор" : "Выбрать блок",
        () => {
          if (!busy) {
            picking = !picking;
            panel = !picking;
            render();
          }
        },
        picking ? "primary" : "",
      );
      picker.prepend(icon(picking ? "close" : "target"));
      picker.setAttribute(
        "aria-label",
        picking ? "Отменить выбор" : "Выбрать блок · C",
      );
      picker.setAttribute("aria-pressed", String(picking));
      picker.setAttribute("aria-keyshortcuts", "C");
      if (!picking) {
        const shortcut = element("kbd", "C");
        shortcut.setAttribute("aria-hidden", "true");
        picker.append(shortcut);
      }
      toolbar.append(picker);
    }
    if (options.toolbar !== false) ui.append(toolbar);
    if (picking)
      ui.append(element("div", "Нажмите на блок · Esc — отмена", "pick-hint"));
    if (panel && !picking) {
      const pane = element("section", "", "panel");
      pane.setAttribute("role", "dialog");
      pane.setAttribute("aria-label", "Комментарии к интерфейсу");
      const header = element("header");
      header.append(
        element("strong", selected ? selected.anchor.label : "Комментарии"),
        action(
          "",
          () => {
            panel = false;
            render();
          },
          "icon-button",
        ),
      );
      const close = header.querySelector("button");
      close?.setAttribute("aria-label", "Закрыть комментарии");
      close?.append(icon("close"));
      pane.append(header);
      const body = element("div", "", "body");
      if (!session) {
        const loginBlock = element("div", "", "login");
        loginBlock.append(
          element("strong", "Войдите в Notemora"),
          action(
            busy ? "Открываем вход…" : "Войти",
            () => void login(),
            "primary",
          ),
        );
        body.append(loginBlock);
      } else {
        const account = element("div", "", "controls account");
        const logoutButton = action("Выйти", () => void logout(), "link");
        logoutButton.prepend(icon("logout"));
        account.append(
          element("span", session.user.name, "muted"),
          logoutButton,
        );
        body.append(account);
        if (selected) {
          const back = action(
            "Все обсуждения",
            () => {
              selected = undefined;
              render();
            },
            "back link",
          );
          back.prepend(icon("back"));
          body.append(
            back,
            element("div", selected.context.pageTitle, "block-label"),
          );
          const controls = element("div", "", "controls");
          const show = action("Показать блок", showBlock);
          show.dataset.focus = "show-block";
          show.prepend(icon("target"));
          controls.append(show);
          body.append(controls);
          const thread = live().find(
            (thread) => thread.id === selected?.threadId,
          );
          if (!thread) body.append(element("p", "Новое обсуждение", "muted"));
          for (const comment of thread?.comments ?? []) {
            const article = element("article", "", "message");
            const heading = element("header");
            heading.append(
              element("strong", comment.author.name),
              element(
                "span",
                new Date(comment.createdAt).toLocaleString("ru-RU"),
                "muted",
              ),
            );
            article.append(heading, element("p", comment.body));
            for (const file of comment.attachments)
              article.append(image(file.id));
            if (!comment.attachments.length)
              article.append(
                element(
                  "span",
                  comment.captureState === "failed"
                    ? "Снимок не получен"
                    : "Без нового снимка",
                  "muted",
                ),
              );
            const footer = element("footer");
            footer.append(
              element(
                "span",
                "До " + new Date(comment.expiresAt).toLocaleDateString("ru-RU"),
              ),
            );
            if (comment.canDelete) {
              if (confirmation === comment.id) {
                const buttons = element("div", "", "inline");
                buttons.append(
                  action("Удалить", () => void remove(comment.id)),
                  action("Отмена", () => {
                    confirmation = "";
                    render();
                  }),
                );
                footer.append(buttons);
              } else
                footer.append(
                  action(
                    "Удалить",
                    () => {
                      confirmation = comment.id;
                      render();
                    },
                    "link danger",
                  ),
                );
            }
            article.append(footer);
            body.append(article);
          }
        } else {
          const input = element("input");
          input.type = "search";
          input.placeholder = "Поиск по замечаниям";
          input.setAttribute("aria-label", "Поиск комментариев");
          input.value = search;
          input.dataset.focus = "search";
          input.oninput = () => {
            search = input.value;
            render();
          };
          body.append(input);
          const controls = element("div", "", "controls");
          controls.append(
            action(allPages ? "Все страницы" : "Эта страница", () => {
              allPages = !allPages;
              render();
            }),
            action(loading ? "Загрузка…" : "Обновить", () => void load()),
          );
          body.append(controls);
          const query = search.trim().toLocaleLowerCase();
          const list = live().filter(
            (thread) =>
              (allPages || thread.context.pageKey === context().pageKey) &&
              (!query ||
                [
                  thread.context.pageTitle,
                  thread.anchor.label,
                  ...thread.comments.map((comment) => comment.body),
                ].some((value) => value.toLocaleLowerCase().includes(query))),
          );
          if (!list.length)
            body.append(element("div", "Нет комментариев", "empty"));
          for (const thread of list) {
            const row = action(
              "",
              () =>
                choose({
                  anchor: thread.anchor,
                  context: thread.context,
                  threadId: thread.id,
                }),
              "row",
            );
            row.append(
              element("strong", thread.context.pageTitle),
              element("span", thread.comments[0]?.body ?? ""),
              element(
                "span",
                `${thread.anchor.label} · ${thread.comments.length}`,
              ),
            );
            body.append(row);
          }
        }
      }
      if (error) {
        const notice = element("p", error, "error");
        notice.setAttribute("role", "alert");
        body.append(notice);
      }
      pane.append(body);
      if (session && selected) {
        const form = element("form", "", "composer");
        const label = element(
          "label",
          selected.threadId ? "Ответить" : "Комментарий",
        );
        const input = element("textarea");
        input.maxLength = 4000;
        input.value = draft().body;
        input.dataset.focus = "composer";
        input.id = "review-composer";
        input.required = true;
        input.disabled = busy;
        label.htmlFor = input.id;
        input.oninput = () => {
          const value = draft();
          if (value.body !== input.value) {
            value.body = input.value;
            value.requestId = crypto.randomUUID();
            value.prepared = undefined;
          }
          beginCapture(value, selected!.anchor);
        };
        const button = element(
          "button",
          busy ? "Отправка…" : "Отправить",
          "primary",
        );
        button.type = "submit";
        button.disabled = busy;
        form.onsubmit = (event) => {
          event.preventDefault();
          if (!busy) void send();
        };
        form.append(
          label,
          input,
          ...(options.screenshots === false
            ? []
            : [element("span", "Снимок страницы будет прикреплён.", "muted")]),
          button,
        );
        pane.append(form);
      }
      for (const button of pane.querySelectorAll("button"))
        if (busy) button.disabled = true;
      ui.append(pane);
    }
    if (focusName) {
      const next = shadow.querySelector(`[data-focus="${focusName}"]`);
      if (
        next instanceof HTMLInputElement ||
        next instanceof HTMLTextAreaElement
      ) {
        if (!next.disabled) {
          next.focus({ preventScroll: true });
          if (selectionStart !== null)
            next.setSelectionRange(selectionStart, selectionStart);
        }
      }
    }
    positionToolbar();
    queueGeometry();
  }
  function inside(event: Event) {
    return event.composedPath().includes(host);
  }
  function captureEvent(event: Event) {
    if (!enabled || inside(event)) return;
    if (reveal && event.type === "pointerdown") {
      cancelReveal();
      render();
    }
    if (event.type === "click" && performance.now() < swallowClickUntil) {
      event.preventDefault();
      event.stopImmediatePropagation();
      swallowClickUntil = 0;
      return;
    }
    if (!picking || busy) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.type === "pointercancel" || event.type === "touchcancel")
      return clearPointer();
    if (event.type === "pointerdown" && event instanceof MouseEvent) {
      pointerPoint = { x: event.clientX, y: event.clientY };
      focusedTarget = undefined;
      queueHighlight();
    }
    let point: { clientX: number; clientY: number } | undefined;
    if (
      event instanceof MouseEvent &&
      (event.type === "pointerup" || event.type === "click")
    )
      point = event;
    if (
      typeof TouchEvent !== "undefined" &&
      event instanceof TouchEvent &&
      event.type === "touchend"
    )
      point = event.changedTouches[0];
    if (point && event.target instanceof Element) {
      const keyboardClick =
        event.type === "click" &&
        event instanceof MouseEvent &&
        event.detail === 0;
      const target = keyboardClick
        ? event.target
        : document.elementFromPoint(point.clientX, point.clientY);
      if (!target || target.closest("[data-review-widget]")) return;
      swallowClickUntil = performance.now() + 700;
      const rect = anchorTarget(target).getBoundingClientRect();
      const anchor = anchorFor(
        target,
        keyboardClick ? rect.left + rect.width / 2 : point.clientX,
        keyboardClick ? rect.top + rect.height / 2 : point.clientY,
      );
      const page = context();
      const existing = live().find(
        (thread) =>
          thread.context.pageKey === page.pageKey &&
          thread.anchor.key === anchor.key,
      );
      choose({ anchor, context: page, threadId: existing?.id });
    }
  }
  function keyboard(event: KeyboardEvent) {
    if (!enabled || event.defaultPrevented) return;
    const editing = event
      .composedPath()
      .some(
        (node) =>
          node instanceof HTMLInputElement ||
          node instanceof HTMLTextAreaElement ||
          node instanceof HTMLSelectElement ||
          (node instanceof HTMLElement && node.isContentEditable),
      );
    if (event.key === "Escape" && active && (panel || picking || reveal)) {
      event.stopImmediatePropagation();
      if (reveal) return finishReveal(true);
      if (picking) {
        picking = false;
        panel = true;
      } else panel = false;
      render();
    }
    if (
      !editing &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      (event.code === "KeyC" || event.key.toLowerCase() === "c")
    ) {
      event.preventDefault();
      event.stopImmediatePropagation();
      active = true;
      if (session && !busy) {
        picking = !picking;
        panel = !picking;
        if (
          picking &&
          document.activeElement instanceof Element &&
          document.activeElement !== document.body &&
          document.activeElement !== document.documentElement &&
          !document.activeElement.closest("[data-review-widget]")
        )
          focusedTarget = document.activeElement;
      } else panel = true;
      render();
    }
  }
  const events = [
    "pointerdown",
    "pointerup",
    "mousedown",
    "mouseup",
    "touchstart",
    "touchend",
    "pointercancel",
    "touchcancel",
    "click",
  ];
  for (const name of events)
    document.addEventListener(name, captureEvent, {
      capture: true,
      passive: false,
    });
  // Shadow DOM не должен отдавать Tab/Escape обработчикам модального окна хоста.
  const isolateKeyboard = (event: KeyboardEvent) => {
    if (!enabled || !inside(event)) return;
    keyboard(event);
    event.stopImmediatePropagation();
  };
  document.addEventListener("keydown", isolateKeyboard, true);
  document.addEventListener("keydown", keyboard, true);
  document.addEventListener("pointermove", pointerMove, {
    capture: true,
    passive: true,
  });
  document.addEventListener("pointerout", pointerOut, true);
  document.addEventListener("focusin", focusTarget, true);
  window.addEventListener("blur", clearPointer);
  window.addEventListener("scroll", queueGeometry, true);
  window.addEventListener("resize", queueGeometry);
  const observer = new MutationObserver(queueGeometry);
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["class", "style", "hidden", "inert", "aria-hidden"],
  });
  const refresh = () => {
    if (enabled && !document.hidden && active && !busy) void load();
  };
  const timer = setInterval(refresh, 30000);
  window.addEventListener("focus", refresh);
  render();
  return {
    open() {
      if (!enabled || destroyed) return;
      active = true;
      panel = true;
      render();
    },
    signIn: login,
    toggle() {
      if (!enabled || destroyed || busy) return;
      active = !active;
      panel = active;
      picking = false;
      render();
    },
    pick() {
      if (!enabled || destroyed || busy) return;
      active = true;
      picking = session ? !picking : false;
      panel = !picking;
      render();
    },
    setEnabled(next) {
      if (destroyed || enabled === next) return;
      enabled = next;
      if (!enabled) {
        active = false;
        panel = false;
        picking = false;
        swallowClickUntil = 0;
      }
      render();
    },
    refreshContext() {
      if (destroyed) return;
      const nextPage = context().pageKey;
      if (pageKey !== nextPage) {
        selected = undefined;
        picking = false;
        clearPointer();
        cancelReveal();
      }
      pageKey = nextPage;
      render();
    },
    destroy() {
      destroyed = true;
      controller.abort();
      ++revision;
      clearInterval(timer);
      cancelReveal();
      if (frame) cancelAnimationFrame(frame);
      if (highlightFrame) cancelAnimationFrame(highlightFrame);
      observer.disconnect();
      document.removeEventListener("keydown", isolateKeyboard, true);
      document.removeEventListener("keydown", keyboard, true);
      document.removeEventListener("pointermove", pointerMove, true);
      document.removeEventListener("pointerout", pointerOut, true);
      document.removeEventListener("focusin", focusTarget, true);
      window.removeEventListener("blur", clearPointer);
      for (const name of events)
        document.removeEventListener(name, captureEvent, true);
      window.removeEventListener("scroll", queueGeometry, true);
      window.removeEventListener("resize", queueGeometry);
      window.removeEventListener("focus", refresh);
      clearImages();
      drafts.clear();
      highlighter.destroy();
      host.remove();
    },
  };
}
