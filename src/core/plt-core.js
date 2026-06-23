const DEFAULT_UNITS_PER_INCH = 1016;
const DEFAULT_MARGIN_PT = 36;
const DEFAULT_LINE_WIDTH_PT = 0.75;
const DEFAULT_FONT_SIZE_PT = 10;

const MM_TO_PT = 72 / 25.4;
const PAPER_SIZES_MM = {
  A0: [841, 1189],
  A1: [594, 841],
  A2: [420, 594],
  A3: [297, 420],
  A4: [210, 297]
};

const PEN_COLORS = [
  [0, 0, 0],
  [0.1, 0.1, 0.1],
  [0.85, 0.1, 0.1],
  [0.1, 0.45, 0.1],
  [0.15, 0.25, 0.8],
  [0.55, 0.15, 0.7],
  [0.1, 0.6, 0.6],
  [0.7, 0.45, 0.1]
];

const textEncoder = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;

export function convertPltToPdf(source, options = {}) {
  return convertDrawingToPdf(source, options);
}

export function convertDrawingToPdf(inputDrawing, options = {}) {
  const unitsPerInch = options.unitsPerInch ?? DEFAULT_UNITS_PER_INCH;
  const marginPt = options.marginPt ?? DEFAULT_MARGIN_PT;
  const lineWidthPt = options.lineWidthPt ?? DEFAULT_LINE_WIDTH_PT;
  const fontSizePt = options.fontSizePt ?? DEFAULT_FONT_SIZE_PT;
  const shapeLineWidthOverrides = options.shapeLineWidthOverrides ?? {};

  const drawing = normalizeDrawing(inputDrawing);
  const metrics = measureDrawing(drawing, unitsPerInch, fontSizePt, lineWidthPt, shapeLineWidthOverrides);
  const scale = 72 / unitsPerInch;
  const layout = resolvePdfLayout(metrics, scale, marginPt, options);
  const pages = layout.type === "tiled"
    ? createTiledPages(drawing, layout, scale, lineWidthPt, fontSizePt, shapeLineWidthOverrides)
    : [createSinglePage(drawing, layout, scale, lineWidthPt, fontSizePt, shapeLineWidthOverrides)];

  return buildPdfDocument(pages);
}

export function getTiledPdfLayout(inputDrawing, options = {}) {
  const unitsPerInch = options.unitsPerInch ?? DEFAULT_UNITS_PER_INCH;
  const marginPt = options.marginPt ?? DEFAULT_MARGIN_PT;
  const lineWidthPt = options.lineWidthPt ?? DEFAULT_LINE_WIDTH_PT;
  const fontSizePt = options.fontSizePt ?? DEFAULT_FONT_SIZE_PT;
  const shapeLineWidthOverrides = options.shapeLineWidthOverrides ?? {};
  const drawing = normalizeDrawing(inputDrawing);
  const metrics = measureDrawing(drawing, unitsPerInch, fontSizePt, lineWidthPt, shapeLineWidthOverrides);
  const scale = 72 / unitsPerInch;
  return resolvePdfLayout(metrics, scale, marginPt, options);
}

function createSinglePage(drawing, layout, scale, lineWidthPt, fontSizePt, shapeLineWidthOverrides) {
  const content = [];
  content.push("q");
  content.push(`${lineWidthPt} w`);
  content.push("1 j");
  content.push("1 J");

  const transform = (point) => transformPoint(point, scale, layout.xOffset, layout.yOffset);
  appendDrawingContent(content, drawing, transform, scale, lineWidthPt, fontSizePt, shapeLineWidthOverrides);
  content.push("Q");

  return {
    widthPt: layout.widthPt,
    heightPt: layout.heightPt,
    content: content.join("\n")
  };
}

function createTiledPages(drawing, layout, scale, lineWidthPt, fontSizePt, shapeLineWidthOverrides) {
  const pages = [];
  for (let row = 0; row < layout.rows; row += 1) {
    for (let column = 0; column < layout.columns; column += 1) {
      const tileXPt = column * layout.tileWidthPt;
      const tileYPt = row * layout.tileHeightPt;
      const content = [];
      content.push("q");
      content.push(`${layout.marginPt.toFixed(3)} ${layout.marginPt.toFixed(3)} ${layout.tileWidthPt.toFixed(3)} ${layout.tileHeightPt.toFixed(3)} re`);
      content.push("W");
      content.push("n");
      content.push(`${lineWidthPt} w`);
      content.push("1 j");
      content.push("1 J");

      const transform = (point) => transformTiledPoint(point, layout, scale, tileXPt, tileYPt);
      appendDrawingContent(content, drawing, transform, scale, lineWidthPt, fontSizePt, shapeLineWidthOverrides);
      content.push("Q");
      pages.push({
        widthPt: layout.pageWidthPt,
        heightPt: layout.pageHeightPt,
        content: content.join("\n")
      });
    }
  }
  return pages;
}

function appendDrawingContent(content, drawing, transform, scale, lineWidthPt, fontSizePt, shapeLineWidthOverrides) {
  let activeColor = null;
  let activeLineWidthPt = null;
  for (const shape of drawing.shapes) {
    const pen = shape.pen ?? 0;
    const color = PEN_COLORS[pen % PEN_COLORS.length] ?? PEN_COLORS[0];
    if (!activeColor || color.some((v, i) => v !== activeColor[i])) {
      content.push(`${color[0]} ${color[1]} ${color[2]} RG`);
      content.push(`${color[0]} ${color[1]} ${color[2]} rg`);
      activeColor = color;
    }
    const shapeLineWidthPt = resolveShapeLineWidthPt(shape, lineWidthPt, scale, shapeLineWidthOverrides);
    if (shape.type === "path" || shape.type === "circle") {
      if (activeLineWidthPt !== shapeLineWidthPt) {
        content.push(`${shapeLineWidthPt.toFixed(3)} w`);
        activeLineWidthPt = shapeLineWidthPt;
      }
    }
    if (shape.type === "path") {
      const points = shape.points;
      if (points.length < 2) continue;
      const first = transform(points[0]);
      content.push(`${first.x.toFixed(3)} ${first.y.toFixed(3)} m`);
      for (let i = 1; i < points.length; i += 1) {
        const p = transform(points[i]);
        content.push(`${p.x.toFixed(3)} ${p.y.toFixed(3)} l`);
      }
      content.push("S");
    } else if (shape.type === "circle") {
      const circlePoints = approximateCircle(shape.center, shape.radius, 48);
      if (circlePoints.length < 2) continue;
      const first = transform(circlePoints[0]);
      content.push(`${first.x.toFixed(3)} ${first.y.toFixed(3)} m`);
      for (let i = 1; i < circlePoints.length; i += 1) {
        const p = transform(circlePoints[i]);
        content.push(`${p.x.toFixed(3)} ${p.y.toFixed(3)} l`);
      }
      content.push("S");
    } else if (shape.type === "text") {
      const point = transform(shape.point);
      const size = shape.fontSizePt ?? fontSizePt;
      content.push("BT");
      content.push(`/F1 ${size.toFixed(2)} Tf`);
      content.push(`${point.x.toFixed(3)} ${point.y.toFixed(3)} Td`);
      content.push(`(${escapePdfString(shape.text)}) Tj`);
      content.push("ET");
    }
  }
}

export function parseHpgl(source) {
  const cleaned = source.replace(/\0/g, "");
  let index = 0;
  let mode = "absolute";
  let penDown = false;
  let currentPen = 1;
  let currentPosition = { x: 0, y: 0 };
  let currentLineWidthUnits = null;
  let stroke = [];
  const shapes = [];
  const penWidths = new Map();
  let nextShapeId = 1;

  const createShape = (shape) => ({
    id: `shape-${nextShapeId++}`,
    ...shape
  });

  const flushStroke = () => {
    if (stroke.length > 1) {
      shapes.push(createShape({
        type: "path",
        pen: currentPen,
        points: stroke,
        lineWidthUnits: currentLineWidthUnits
      }));
    }
    stroke = [];
  };

  const addPoint = (x, y) => {
    const startPoint = { ...currentPosition };
    const point = mode === "relative"
      ? { x: currentPosition.x + x, y: currentPosition.y + y }
      : { x, y };
    currentPosition = point;
    if (penDown) {
      if (stroke.length === 0) {
        stroke.push(startPoint);
      }
      stroke.push(point);
    }
    return point;
  };

  const addAbsolutePoint = (point) => {
    const startPoint = { ...currentPosition };
    currentPosition = point;
    if (penDown) {
      if (stroke.length === 0) {
        stroke.push(startPoint);
      }
      stroke.push(point);
    }
    return point;
  };

  const addArc = (center, angleDeg, chordAngleDeg = 5) => {
    const radius = distance(currentPosition, center);
    if (!Number.isFinite(radius) || radius <= 0 || !Number.isFinite(angleDeg) || angleDeg === 0) {
      return;
    }
    const startAngle = Math.atan2(currentPosition.y - center.y, currentPosition.x - center.x);
    const totalAngle = degreesToRadians(angleDeg);
    const chordAngle = Math.max(Math.abs(Number(chordAngleDeg) || 5), 0.1);
    const steps = Math.max(1, Math.ceil(Math.abs(angleDeg) / chordAngle));
    for (let i = 1; i <= steps; i += 1) {
      const theta = startAngle + (totalAngle * i) / steps;
      addAbsolutePoint({
        x: center.x + Math.cos(theta) * radius,
        y: center.y + Math.sin(theta) * radius
      });
    }
  };

  while (index < cleaned.length) {
    const ch = cleaned[index];
    if (isIgnorable(ch)) {
      index += 1;
      continue;
    }

    const command = cleaned.slice(index, index + 2).toUpperCase();
    index += 2;

    if (!/^[A-Z]{2}$/.test(command)) {
      index += 1;
      continue;
    }

    if (command === "LB") {
      const start = index;
      while (index < cleaned.length && cleaned[index] !== "\x03" && cleaned[index] !== ";") {
        index += 1;
      }
      const text = cleaned.slice(start, index);
      if (text.length > 0) {
        shapes.push(createShape({ type: "text", pen: currentPen, point: { ...currentPosition }, text }));
      }
      if (cleaned[index] === "\x03" || cleaned[index] === ";") {
        index += 1;
      }
      continue;
    }

    let argStart = index;
    while (index < cleaned.length && cleaned[index] !== ";") {
      index += 1;
    }
    const argText = cleaned.slice(argStart, index);
    if (cleaned[index] === ";") {
      index += 1;
    }

    const nums = parseNumberList(argText);

    switch (command) {
      case "IN":
        mode = "absolute";
        penDown = false;
        currentPen = 1;
        currentPosition = { x: 0, y: 0 };
        currentLineWidthUnits = null;
        penWidths.clear();
        flushStroke();
        break;
      case "SP":
        flushStroke();
        currentPen = Number.isFinite(nums[0]) ? nums[0] : 1;
        currentLineWidthUnits = penWidths.has(currentPen) ? penWidths.get(currentPen) : null;
        break;
      case "PA":
        mode = "absolute";
        if (nums.length >= 2) {
          for (let i = 0; i + 1 < nums.length; i += 2) {
            addPoint(nums[i], nums[i + 1]);
          }
        }
        break;
      case "PR":
        mode = "relative";
        if (nums.length >= 2) {
          for (let i = 0; i + 1 < nums.length; i += 2) {
            addPoint(nums[i], nums[i + 1]);
          }
        }
        break;
      case "PU":
        flushStroke();
        penDown = false;
        if (nums.length >= 2) {
          for (let i = 0; i + 1 < nums.length; i += 2) {
            addPoint(nums[i], nums[i + 1]);
          }
        }
        break;
      case "PD":
        penDown = true;
        if (nums.length >= 2) {
          for (let i = 0; i + 1 < nums.length; i += 2) {
            addPoint(nums[i], nums[i + 1]);
          }
        }
        break;
      case "CI": {
        flushStroke();
        const radius = nums[0] ?? 0;
        if (radius > 0) {
          shapes.push(createShape({
            type: "circle",
            pen: currentPen,
            center: { ...currentPosition },
            radius,
            lineWidthUnits: currentLineWidthUnits
          }));
        }
        break;
      }
      case "AA": {
        if (nums.length >= 3) {
          addArc({ x: nums[0], y: nums[1] }, nums[2], nums[3]);
        }
        break;
      }
      case "AR": {
        if (nums.length >= 3) {
          addArc({ x: currentPosition.x + nums[0], y: currentPosition.y + nums[1] }, nums[2], nums[3]);
        }
        break;
      }
      case "AT":
      case "DI":
      case "SI":
      case "SL":
      case "LT":
      case "SC":
      case "VS":
      case "WU":
      case "CO":
        break;
      case "PW": {
        const widthUnits = nums[0];
        if (Number.isFinite(widthUnits) && widthUnits >= 0) {
          const targetPen = Number.isFinite(nums[1]) ? nums[1] : currentPen;
          penWidths.set(targetPen, widthUnits);
          if (targetPen === currentPen) {
            currentLineWidthUnits = widthUnits;
          }
        }
        break;
      }
      default:
        break;
    }
  }

  flushStroke();
  return { shapes };
}

export function measureDrawing(
  drawing,
  unitsPerInch = DEFAULT_UNITS_PER_INCH,
  fontSizePt = DEFAULT_FONT_SIZE_PT,
  defaultLineWidthPt = DEFAULT_LINE_WIDTH_PT,
  shapeLineWidthOverrides = {}
) {
  const scale = 72 / unitsPerInch;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  const includePoint = (point) => {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  };

  for (const shape of drawing.shapes) {
    const lineWidthUnits = resolveShapeLineWidthUnits(shape, defaultLineWidthPt, scale, shapeLineWidthOverrides);
    const halfLineWidthUnits = lineWidthUnits / 2;
    if (shape.type === "path") {
      for (const point of shape.points) {
        includePoint({ x: point.x - halfLineWidthUnits, y: point.y - halfLineWidthUnits });
        includePoint({ x: point.x + halfLineWidthUnits, y: point.y + halfLineWidthUnits });
      }
    } else if (shape.type === "circle") {
      const radius = shape.radius + halfLineWidthUnits;
      includePoint({ x: shape.center.x - radius, y: shape.center.y - radius });
      includePoint({ x: shape.center.x + radius, y: shape.center.y + radius });
    } else if (shape.type === "text") {
      const width = (shape.text.length * fontSizePt * 0.6) / scale;
      const height = fontSizePt / scale;
      includePoint(shape.point);
      includePoint({ x: shape.point.x + width, y: shape.point.y + height });
    }
  }

  if (!Number.isFinite(minX)) {
    minX = 0;
    minY = 0;
    maxX = unitsPerInch;
    maxY = unitsPerInch;
  }

  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX,
    height: maxY - minY
  };
}

function transformPoint(point, scale, xOffset, yOffset, pageHeight) {
  return {
    x: point.x * scale + xOffset,
    y: point.y * scale + yOffset
  };
}

function transformTiledPoint(point, layout, scale, tileXPt, tileYPt) {
  const drawingXPt = (point.x - layout.metrics.minX) * scale;
  const drawingYPt = (point.y - layout.metrics.minY) * scale;
  return {
    x: layout.marginPt + drawingXPt - tileXPt,
    y: layout.marginPt + drawingYPt - tileYPt
  };
}

function resolvePdfLayout(metrics, scale, marginPt, options) {
  const paperSize = normalizePaperSize(options.paperSize);
  if (!paperSize) {
    const widthPt = Math.max(72, metrics.width * scale + marginPt * 2);
    const heightPt = Math.max(72, metrics.height * scale + marginPt * 2);
    return {
      type: "single",
      metrics,
      widthPt,
      heightPt,
      xOffset: marginPt - metrics.minX * scale,
      yOffset: marginPt - metrics.minY * scale,
      marginPt
    };
  }

  const orientation = normalizeOrientation(options.orientation);
  const [shortEdgePt, longEdgePt] = PAPER_SIZES_MM[paperSize].map((value) => value * MM_TO_PT);
  let pageWidthPt = shortEdgePt;
  let pageHeightPt = longEdgePt;
  if (orientation === "landscape" || (orientation === "auto" && metrics.width >= metrics.height)) {
    pageWidthPt = longEdgePt;
    pageHeightPt = shortEdgePt;
  }

  const tileWidthPt = Math.max(1, pageWidthPt - marginPt * 2);
  const tileHeightPt = Math.max(1, pageHeightPt - marginPt * 2);
  const drawingWidthPt = Math.max(1, metrics.width * scale);
  const drawingHeightPt = Math.max(1, metrics.height * scale);
  const columns = Math.max(1, Math.ceil(drawingWidthPt / tileWidthPt));
  const rows = Math.max(1, Math.ceil(drawingHeightPt / tileHeightPt));

  return {
    type: "tiled",
    metrics,
    paperSize,
    orientation: pageWidthPt > pageHeightPt ? "landscape" : "portrait",
    pageWidthPt,
    pageHeightPt,
    tileWidthPt,
    tileHeightPt,
    drawingWidthPt,
    drawingHeightPt,
    columns,
    rows,
    pageCount: columns * rows,
    marginPt
  };
}

function normalizePaperSize(value) {
  if (!value || value === "auto" || value === "fit") return null;
  const normalized = String(value).trim().toUpperCase();
  return Object.hasOwn(PAPER_SIZES_MM, normalized) ? normalized : null;
}

function normalizeOrientation(value) {
  const normalized = String(value ?? "auto").trim().toLowerCase();
  if (normalized === "portrait" || normalized === "landscape") return normalized;
  return "auto";
}

function resolveShapeLineWidthPt(shape, defaultLineWidthPt, scale, shapeLineWidthOverrides = {}) {
  const override = shape?.id ? shapeLineWidthOverrides[shape.id] : undefined;
  if (Number.isFinite(override)) {
    return Math.max(override, 0.01);
  }
  if (!Number.isFinite(shape.lineWidthUnits)) {
    return defaultLineWidthPt;
  }
  return Math.max(shape.lineWidthUnits * scale, 0.01);
}

function resolveShapeLineWidthUnits(shape, defaultLineWidthPt, scale, shapeLineWidthOverrides = {}) {
  const override = shape?.id ? shapeLineWidthOverrides[shape.id] : undefined;
  if (Number.isFinite(override)) {
    return Math.max(override / scale, 0.01);
  }
  if (Number.isFinite(shape.lineWidthUnits)) {
    return Math.max(shape.lineWidthUnits, 0.01);
  }
  return defaultLineWidthPt / scale;
}

function approximateCircle(center, radius, steps) {
  const points = [];
  for (let i = 0; i <= steps; i += 1) {
    const theta = (Math.PI * 2 * i) / steps;
    points.push({
      x: center.x + Math.cos(theta) * radius,
      y: center.y + Math.sin(theta) * radius
    });
  }
  return points;
}

function degreesToRadians(degrees) {
  return (degrees * Math.PI) / 180;
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function parseNumberList(text) {
  if (!text.trim()) return [];
  return text
    .split(/[, \t\r\n]+/)
    .filter(Boolean)
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));
}

function escapePdfString(text) {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

function streamObject(content) {
  return `<< /Length ${utf8ByteLength(content)} >>\nstream\n${content}\nendstream`;
}

function addObject(objects, content) {
  objects.push(content);
  return objects.length - 1;
}

function buildPdfDocument(pages) {
  const objects = [];
  objects.push(null);
  const fontObj = addObject(objects, `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`);
  const pageEntries = [];
  const pagesObj = addObject(objects, "");

  for (const page of pages) {
    const contentObj = addObject(objects, streamObject(page.content));
    const pageObj = addObject(
      objects,
      `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${page.widthPt.toFixed(3)} ${page.heightPt.toFixed(3)}] /Resources << /Font << /F1 ${fontObj} 0 R >> >> /Contents ${contentObj} 0 R >>`
    );
    pageEntries.push(pageObj);
  }

  objects[pagesObj] = `<< /Type /Pages /Kids [${pageEntries.map((pageObj) => `${pageObj} 0 R`).join(" ")}] /Count ${pageEntries.length} >>`;
  const catalogObj = addObject(objects, `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`);
  return buildPdf(objects, catalogObj);
}

function buildPdf(objects, catalogObj) {
  const chunks = ["%PDF-1.4\n"];
  const offsets = [0];
  let offset = utf8ByteLength(chunks[0]);

  for (let i = 1; i < objects.length; i += 1) {
    const body = `${i} 0 obj\n${objects[i]}\nendobj\n`;
    offsets.push(offset);
    chunks.push(body);
    offset += utf8ByteLength(body);
  }

  const xrefOffset = offset;
  let xref = `xref\n0 ${objects.length}\n`;
  xref += "0000000000 65535 f \n";
  for (let i = 1; i < objects.length; i += 1) {
    xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  const trailer = `trailer\n<< /Size ${objects.length} /Root ${catalogObj} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  chunks.push(xref, trailer);
  return chunks.join("");
}

function isIgnorable(ch) {
  return ch === "\n" || ch === "\r" || ch === "\t" || ch === " " || ch === ",";
}

function normalizeDrawing(source) {
  if (typeof source === "string") {
    return parseHpgl(source);
  }
  return source ?? { shapes: [] };
}

function utf8ByteLength(text) {
  if (textEncoder) {
    return textEncoder.encode(text).length;
  }
  return Buffer.byteLength(text, "utf8");
}
