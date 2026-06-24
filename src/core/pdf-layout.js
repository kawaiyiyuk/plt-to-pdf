const MM_PER_PT = 25.4 / 72;
export const DEFAULT_PAGE_GAP_PX = 24;
export const PAGE_SHADOW_MARGIN_PX = 10;

export function buildPdfLayout(pages, options = {}) {
  const mode = options.mode === "vertical" ? "vertical" : "horizontal";
  const count = clamp(Math.trunc(Number(options.count) || 1), 1, 24);
  const gapPx = Number.isFinite(options.gapPx) ? Math.max(options.gapPx, 0) : DEFAULT_PAGE_GAP_PX;
  const cropMm = normalizeCropMm(options.cropMm);
  const autoCrop = Boolean(options.autoCrop);
  const autoCropPaddingMm = normalizeNumber(options.autoCropPaddingMm);
  const items = pages.map((page) => {
    const crop = resolvePageCrop(page, cropMm, {
      autoCrop,
      autoCropPaddingMm
    });
    return {
      page,
      crop,
      width: crop.width,
      height: crop.height,
      x: 0,
      y: 0
    };
  });

  if (!items.length) {
    return {
      mode,
      count,
      items,
    bounds: { width: 0, height: 0 },
      cropMm,
      autoCrop,
      autoCropPaddingMm
    };
  }

  if (mode === "horizontal") {
    layoutHorizontal(items, count, gapPx);
  } else {
    layoutVertical(items, count, gapPx);
  }

  return {
    mode,
    count,
    items,
    bounds: measureItems(items),
    cropMm,
    autoCrop,
    autoCropPaddingMm
  };
}

export function resolvePageCrop(page, cropMm = {}, options = {}) {
  const pxPerPtX = page.widthPx / Math.max(page.widthPt, 1);
  const pxPerPtY = page.heightPx / Math.max(page.heightPt, 1);
  const autoBase = options.autoCrop && page.contentBounds
    ? resolveAutoCropBase(page, options.autoCropPaddingMm, pxPerPtX, pxPerPtY)
    : { left: 0, right: 0, top: 0, bottom: 0 };
  const left = autoBase.left + cropMmToPx(cropMm.left, pxPerPtX);
  const right = autoBase.right + cropMmToPx(cropMm.right, pxPerPtX);
  const top = autoBase.top + cropMmToPx(cropMm.top, pxPerPtY);
  const bottom = autoBase.bottom + cropMmToPx(cropMm.bottom, pxPerPtY);
  const maxHorizontalCrop = Math.max(page.widthPx - 1, 1);
  const maxVerticalCrop = Math.max(page.heightPx - 1, 1);
  const clampedLeft = Math.min(left, maxHorizontalCrop);
  const clampedRight = Math.min(right, Math.max(page.widthPx - clampedLeft - 1, 0));
  const clampedTop = Math.min(top, maxVerticalCrop);
  const clampedBottom = Math.min(bottom, Math.max(page.heightPx - clampedTop - 1, 0));

  return {
    x: clampedLeft,
    y: clampedTop,
    width: Math.max(page.widthPx - clampedLeft - clampedRight, 1),
    height: Math.max(page.heightPx - clampedTop - clampedBottom, 1)
  };
}

function resolveAutoCropBase(page, paddingMm, pxPerPtX, pxPerPtY) {
  const bounds = page.contentBounds;
  const paddingX = cropMmToPx(paddingMm, pxPerPtX);
  const paddingY = cropMmToPx(paddingMm, pxPerPtY);
  const leftEdge = Math.max(0, bounds.x - paddingX);
  const topEdge = Math.max(0, bounds.y - paddingY);
  const rightEdge = Math.min(page.widthPx, bounds.x + bounds.width + paddingX);
  const bottomEdge = Math.min(page.heightPx, bounds.y + bounds.height + paddingY);
  return {
    left: leftEdge,
    right: Math.max(page.widthPx - rightEdge, 0),
    top: topEdge,
    bottom: Math.max(page.heightPx - bottomEdge, 0)
  };
}

function layoutHorizontal(items, columns, gapPx) {
  const rowHeights = [];
  for (let index = 0; index < items.length; index += 1) {
    const row = Math.floor(index / columns);
    rowHeights[row] = Math.max(rowHeights[row] ?? 0, items[index].height);
  }
  const rowY = [];
  for (let row = 0; row < rowHeights.length; row += 1) {
    rowY[row] = row === 0 ? PAGE_SHADOW_MARGIN_PX : rowY[row - 1] + rowHeights[row - 1] + gapPx;
  }

  for (let index = 0; index < items.length; index += 1) {
    const row = Math.floor(index / columns);
    const rowStart = row * columns;
    let x = PAGE_SHADOW_MARGIN_PX;
    for (let cursor = rowStart; cursor < index; cursor += 1) {
      x += items[cursor].width + gapPx;
    }
    items[index].x = x;
    items[index].y = rowY[row];
  }
}

function layoutVertical(items, rows, gapPx) {
  const columnWidths = [];
  for (let index = 0; index < items.length; index += 1) {
    const column = Math.floor(index / rows);
    columnWidths[column] = Math.max(columnWidths[column] ?? 0, items[index].width);
  }
  const columnX = [];
  for (let column = 0; column < columnWidths.length; column += 1) {
    columnX[column] = column === 0 ? PAGE_SHADOW_MARGIN_PX : columnX[column - 1] + columnWidths[column - 1] + gapPx;
  }

  for (let index = 0; index < items.length; index += 1) {
    const column = Math.floor(index / rows);
    const columnStart = column * rows;
    let y = PAGE_SHADOW_MARGIN_PX;
    for (let cursor = columnStart; cursor < index; cursor += 1) {
      y += items[cursor].height + gapPx;
    }
    items[index].x = columnX[column];
    items[index].y = y;
  }
}

function measureItems(items) {
  let width = 0;
  let height = 0;
  for (const item of items) {
    width = Math.max(width, item.x + item.width + PAGE_SHADOW_MARGIN_PX);
    height = Math.max(height, item.y + item.height + PAGE_SHADOW_MARGIN_PX);
  }
  return { width, height };
}

function normalizeCropMm(cropMm = {}) {
  return {
    left: normalizeNumber(cropMm.left),
    right: normalizeNumber(cropMm.right),
    top: normalizeNumber(cropMm.top),
    bottom: normalizeNumber(cropMm.bottom)
  };
}

function cropMmToPx(valueMm, pxPerPt) {
  return Math.max(0, normalizeNumber(valueMm) / MM_PER_PT * pxPerPt);
}

function normalizeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(number, 0) : 0;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}
