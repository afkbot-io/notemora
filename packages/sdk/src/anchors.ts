import type { ReviewAnchor } from "./contracts";

/** Один и тот же блок используется для предварительной подсветки и сохранённой привязки. */
export function anchorTarget(target: Element): Element {
  const preferred = target.closest("[data-review-id]");
  return (
    preferred ??
    target.closest(
      'button,a,input,select,textarea,[role="button"],article,section,h1,h2,h3,p,img',
    ) ??
    target
  );
}

/** Читает только явную подпись/тип элемента: текст страницы и значения полей не собираются. */
export function anchorLabel(node: Element): string {
  return (
    node.getAttribute("data-review-label") ||
    ({ BUTTON: "Кнопка", A: "Ссылка", INPUT: "Поле", IMG: "Изображение" }[
      node.tagName
    ] ??
      "Блок")
  ).slice(0, 160);
}

/** Не собирает innerText или значения полей. Для осмысленной подписи используйте data-review-label. */
export function anchorFor(target: Element, x: number, y: number): ReviewAnchor {
  const node = anchorTarget(target);
  const stable = node.getAttribute("data-review-id");
  let selector = stable ? `[data-review-id="${CSS.escape(stable)}"]` : "";
  if (!selector || document.querySelectorAll(selector).length !== 1) {
    const parts: string[] = [];
    let current: Element | null = node;
    while (
      current &&
      current !== document.documentElement &&
      parts.join(" > ").length < 1300
    ) {
      const tag = current.tagName.toLowerCase();
      const siblings = current.parentElement
        ? Array.from(current.parentElement.children).filter(
            (child) => child.tagName === current?.tagName,
          )
        : [];
      parts.unshift(
        tag +
          (siblings.length > 1
            ? `:nth-of-type(${siblings.indexOf(current) + 1})`
            : ""),
      );
      current = current.parentElement;
    }
    selector = parts.join(" > ");
  }
  const rect = node.getBoundingClientRect();
  return {
    key:
      stable &&
      document.querySelectorAll(`[data-review-id="${CSS.escape(stable)}"]`)
        .length === 1
        ? "id:" + stable
        : selector,
    selector,
    label: anchorLabel(node),
    x: Math.min(1, Math.max(0, (x - rect.left) / Math.max(1, rect.width))),
    y: Math.min(1, Math.max(0, (y - rect.top) / Math.max(1, rect.height))),
  };
}

export function locate(anchor: ReviewAnchor): Element | null {
  try {
    const matches = document.querySelectorAll(anchor.selector);
    return matches.length === 1 ? (matches[0] ?? null) : null;
  } catch {
    return null;
  }
}

/** Возвращает видимую часть блока с учётом viewport и прокручиваемых предков. */
export function visibleRect(node: Element) {
  if (
    node.closest('[hidden],[inert],[aria-hidden="true"],[data-review-widget]')
  )
    return null;
  const visibility = getComputedStyle(node);
  if (visibility.visibility === "hidden" || visibility.display === "none")
    return null;
  const box = node.getBoundingClientRect();
  let left = Math.max(0, box.left),
    top = Math.max(0, box.top),
    right = Math.min(innerWidth, box.right),
    bottom = Math.min(innerHeight, box.bottom);
  let parent = node.parentElement;
  while (parent) {
    const style = getComputedStyle(parent);
    const rect = parent.getBoundingClientRect();
    if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
      left = Math.max(left, rect.left);
      right = Math.min(right, rect.right);
    }
    if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
      top = Math.max(top, rect.top);
      bottom = Math.min(bottom, rect.bottom);
    }
    parent = parent.parentElement;
  }
  return right > left && bottom > top
    ? { left, top, width: right - left, height: bottom - top }
    : null;
}

/** URL без query/fragment: токены и параметры форм не становятся частью комментария. */
export function safePageUrl(value: string): string {
  const url = new URL(value);
  return url.origin + url.pathname;
}
