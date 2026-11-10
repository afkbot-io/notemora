import { anchorLabel, visibleRect } from "./anchors";

export type HighlightKind = "pick" | "selected" | "reveal";

/** Владеет рамкой в Shadow DOM; не меняет исходный элемент и не перехватывает указатель. */
export function createHighlighter(shadow: ShadowRoot) {
  const layer = document.createElement("div");
  layer.className = "highlights";
  layer.setAttribute("aria-hidden", "true");
  const box = document.createElement("div");
  box.className = "target-highlight";
  const label = document.createElement("div");
  label.className = "target-label";
  box.hidden = label.hidden = true;
  layer.append(box, label);
  shadow.append(layer);

  function hide() {
    box.hidden = label.hidden = true;
    delete box.dataset.reviewHighlight;
    box.className = "target-highlight";
  }

  return {
    /** Перерисовывает видимую часть блока; положение подписи ограничено viewport в CSS px. */
    show(node: Element, kind: HighlightKind) {
      const rect = visibleRect(node);
      if (!rect) return hide();
      if (box.dataset.reviewHighlight !== kind) {
        box.className = `target-highlight target-highlight--${kind}`;
        box.dataset.reviewHighlight = kind;
      }
      box.hidden = label.hidden = false;
      box.style.cssText = `left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;`;
      const text = anchorLabel(node);
      if (label.textContent !== text) label.textContent = text;
      const width = label.getBoundingClientRect().width;
      const left = Math.max(8, Math.min(innerWidth - width - 8, rect.left));
      const top = Math.max(
        8,
        Math.min(
          innerHeight - 32,
          rect.top >= 36 ? rect.top - 30 : rect.top + rect.height + 6,
        ),
      );
      label.style.cssText = `left:${left}px;top:${top}px;`;
    },
    hide,
    destroy() {
      layer.remove();
    },
  };
}
