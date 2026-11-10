interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Выбирает свободное место сверху, затем ниже. Геометрия в CSS px; при полностью занятом viewport минимизирует перекрытие действий. */
export function placeToolbar(
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  top: number,
  actions: Box[],
) {
  const margin = 12;
  const positions = [
    Math.max(margin, viewport.width - margin - size.width),
    margin,
    Math.max(margin, (viewport.width - size.width) / 2),
  ];
  let best = { left: positions[0]!, top, overlap: Infinity };
  const step = Math.max(1, size.height + 8);
  for (let y = top; y + size.height <= viewport.height - margin; y += step) {
    for (const left of positions) {
      const overlap = actions.reduce(
        (sum, rect) =>
          sum +
          Math.max(
            0,
            Math.min(left + size.width, rect.left + rect.width + 4) -
              Math.max(left, rect.left - 4),
          ) *
            Math.max(
              0,
              Math.min(y + size.height, rect.top + rect.height + 4) -
                Math.max(y, rect.top - 4),
            ),
        0,
      );
      if (overlap < best.overlap) best = { left, top: y, overlap };
    }
    if (best.overlap === 0) break;
  }
  return { left: best.left, top: best.top };
}
