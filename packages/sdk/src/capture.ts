import type { ReviewAnchor } from "./contracts";
import { locate, safePageUrl, visibleRect } from "./anchors";

export interface Capture {
  blob: Blob;
  context: Record<string, unknown>;
}

/** DOM-снимок текущего viewport. Маскирует поля/приватные узлы до рендера и исключает виджет. */
export async function capture(
  anchor: ReviewAnchor,
  onCurrentPage = true,
): Promise<Capture> {
  const { default: html2canvas } = await import("html2canvas");
  const width = Math.min(innerWidth, 4096),
    height = Math.min(innerHeight, 4096);
  const target = onCurrentPage ? locate(anchor) : null;
  const context = {
    url: safePageUrl(location.href),
    viewport: { width, height },
    devicePixelRatio,
    scrollX,
    scrollY,
    capturedAt: new Date().toISOString(),
    targetVisible: target !== null && visibleRect(target) !== null,
    method: "dom-render",
  };
  const canvas = await html2canvas(document.documentElement, {
    x: scrollX,
    y: scrollY,
    width,
    height,
    scale: Math.min(2, devicePixelRatio),
    useCORS: true,
    allowTaint: false,
    logging: false,
    imageTimeout: 4000,
    removeContainer: true,
    ignoreElements: (node) => node.hasAttribute("data-review-widget"),
    onclone: (document) => {
      for (const node of document.querySelectorAll(
        'input,textarea,select,[contenteditable="true"],[data-review-private]',
      )) {
        const rect = node.getBoundingClientRect();
        const placeholder = document.createElement("div");
        placeholder.textContent = "Скрыто";
        const computed = document.defaultView?.getComputedStyle(node);
        placeholder.style.cssText = `box-sizing:border-box;width:${rect.width}px;height:${rect.height}px;background:#dbe2ee;color:transparent;display:${computed?.display ?? "block"};margin:${computed?.margin ?? "0"};vertical-align:${computed?.verticalAlign ?? "baseline"};`;
        node.replaceWith(placeholder);
      }
    },
  });
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (value) =>
        value ? resolve(value) : reject(new Error("Снимок не получен")),
      "image/png",
    ),
  );
  canvas.width = 0;
  canvas.height = 0;
  return { blob, context };
}
