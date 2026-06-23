const MM_TO_PT = 72 / 25.4;
const PAPER_SIZES_MM = {
  A0: [841, 1189],
  A1: [594, 841],
  A2: [420, 594],
  A3: [297, 420],
  A4: [210, 297]
};

const textEncoder = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;

export function getSvgPdfLayout(svg, options = {}) {
  const document = parseHp2xxSvg(svg);
  attachTextLabels(document, options);
  return resolveLayout(document.bounds, options);
}

export function buildPdfFromSvg(svg, options = {}) {
  const document = parseHp2xxSvg(svg);
  attachTextLabels(document, options);
  const layout = resolveLayout(document.bounds, options);
  const pages = layout.type === "tiled"
    ? createTiledPages(document, layout)
    : [createSinglePage(document, layout)];
  return buildPdfDocument(pages);
}

function parseHp2xxSvg(svg) {
  const viewBoxMatch = svg.match(/viewBox="([^"]+)"/);
  if (!viewBoxMatch) {
    throw new Error("hp2xx did not produce an SVG viewBox");
  }
  const [minX, minY, width, height] = viewBoxMatch[1]
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  if (![minX, minY, width, height].every(Number.isFinite)) {
    throw new Error("Invalid SVG viewBox from hp2xx");
  }

  const shapes = [];
  let currentStyle = {};
  const tokenPattern = /<g\b[^>]*style="([^"]*)"[^>]*>|<path\b[^>]*\bd="([^"]+)"[^>]*\/?>/g;
  let match;
  while ((match = tokenPattern.exec(svg))) {
    if (match[1]) {
      currentStyle = parseStyle(match[1]);
    } else if (match[2]) {
      shapes.push({
        commands: parsePathData(match[2]),
        style: currentStyle
      });
    }
  }

  return {
    viewBox: { minX, minY, width, height },
    bounds: measurePathBounds(shapes) ?? { minX, minY, width, height },
    shapes
  };
}

function attachTextLabels(document, options = {}) {
  const labels = Array.isArray(options.textLabels) ? options.textLabels : [];
  const metrics = options.hpglMetrics;
  if (!labels.length || !metrics) {
    document.textLabels = [];
    return;
  }
  const scaleX = document.bounds.width / Math.max(metrics.width, 1);
  const scaleY = document.bounds.height / Math.max(metrics.height, 1);
  const scale = Number.isFinite(scaleX) && Number.isFinite(scaleY)
    ? (scaleX + scaleY) / 2
    : 72 / 1016;

  document.textLabels = labels.map((label) => {
    const direction = normalizeDirection(label.direction);
    const x = document.bounds.minX + (label.x - metrics.minX) * scaleX;
    const y = document.bounds.minY + document.bounds.height - (label.y - metrics.minY) * scaleY;
    return {
      text: label.text,
      x,
      y,
      fontSizePt: Math.max(label.heightUnits * scale, 1),
      advancePt: Math.max(label.widthUnits * scale, 1),
      direction
    };
  });
  document.bounds = measureDocumentBounds(document);
}

function parseStyle(styleText) {
  const style = {};
  for (const item of styleText.split(";")) {
    const [name, rawValue] = item.split(":");
    if (!name || !rawValue) continue;
    style[name.trim()] = rawValue.trim();
  }
  return style;
}

function parsePathData(data) {
  const tokens = data.match(/[AaCcHhLlMmQqSsTtVvZz]|[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g) ?? [];
  const commands = [];
  let index = 0;
  let command = null;
  let current = { x: 0, y: 0 };
  let subpathStart = { x: 0, y: 0 };
  let lastCubicControl = null;
  let lastQuadraticControl = null;

  const isCommandToken = (token) => /^[AaCcHhLlMmQqSsTtVvZz]$/.test(token);
  const hasNumber = () => index < tokens.length && !isCommandToken(tokens[index]);
  const readNumber = () => Number(tokens[index++]);
  const absolutePoint = (x, y, relative) => relative
    ? { x: current.x + x, y: current.y + y }
    : { x, y };
  const addLine = (point) => {
    commands.push({ type: "L", x: point.x, y: point.y });
    current = point;
    lastCubicControl = null;
    lastQuadraticControl = null;
  };
  const addCubic = (control1, control2, point) => {
    commands.push({
      type: "C",
      x1: control1.x,
      y1: control1.y,
      x2: control2.x,
      y2: control2.y,
      x: point.x,
      y: point.y
    });
    current = point;
    lastCubicControl = control2;
    lastQuadraticControl = null;
  };
  const addQuadratic = (control, point) => {
    const control1 = {
      x: current.x + (2 / 3) * (control.x - current.x),
      y: current.y + (2 / 3) * (control.y - current.y)
    };
    const control2 = {
      x: point.x + (2 / 3) * (control.x - point.x),
      y: point.y + (2 / 3) * (control.y - point.y)
    };
    commands.push({
      type: "C",
      x1: control1.x,
      y1: control1.y,
      x2: control2.x,
      y2: control2.y,
      x: point.x,
      y: point.y
    });
    current = point;
    lastCubicControl = null;
    lastQuadraticControl = control;
  };

  while (index < tokens.length) {
    const token = tokens[index];
    if (isCommandToken(token)) {
      command = token;
      index += 1;
      if (command.toUpperCase() === "Z") {
        commands.push({ type: "Z" });
        current = { ...subpathStart };
        lastCubicControl = null;
        lastQuadraticControl = null;
      }
      continue;
    }

    if (!command) {
      index += 1;
      continue;
    }

    const upperCommand = command.toUpperCase();
    const relative = command !== upperCommand;
    if (upperCommand === "M") {
      if (index + 1 >= tokens.length) break;
      const point = absolutePoint(readNumber(), readNumber(), relative);
      commands.push({ type: "M", x: point.x, y: point.y });
      current = point;
      subpathStart = point;
      lastCubicControl = null;
      lastQuadraticControl = null;
      command = relative ? "l" : "L";
      while (index + 1 < tokens.length && hasNumber()) {
        addLine(absolutePoint(readNumber(), readNumber(), relative));
      }
      continue;
    }

    if (upperCommand === "L") {
      while (index + 1 < tokens.length && hasNumber()) {
        addLine(absolutePoint(readNumber(), readNumber(), relative));
      }
      continue;
    }

    if (upperCommand === "H") {
      while (hasNumber()) {
        const x = readNumber();
        addLine({ x: relative ? current.x + x : x, y: current.y });
      }
      continue;
    }

    if (upperCommand === "V") {
      while (hasNumber()) {
        const y = readNumber();
        addLine({ x: current.x, y: relative ? current.y + y : y });
      }
      continue;
    }

    if (upperCommand === "C") {
      while (index + 5 < tokens.length && hasNumber()) {
        const control1 = absolutePoint(readNumber(), readNumber(), relative);
        const control2 = absolutePoint(readNumber(), readNumber(), relative);
        const point = absolutePoint(readNumber(), readNumber(), relative);
        addCubic(control1, control2, point);
      }
      continue;
    }

    if (upperCommand === "S") {
      while (index + 3 < tokens.length && hasNumber()) {
        const control1 = lastCubicControl
          ? { x: current.x * 2 - lastCubicControl.x, y: current.y * 2 - lastCubicControl.y }
          : { ...current };
        const control2 = absolutePoint(readNumber(), readNumber(), relative);
        const point = absolutePoint(readNumber(), readNumber(), relative);
        addCubic(control1, control2, point);
      }
      continue;
    }

    if (upperCommand === "Q") {
      while (index + 3 < tokens.length && hasNumber()) {
        const control = absolutePoint(readNumber(), readNumber(), relative);
        const point = absolutePoint(readNumber(), readNumber(), relative);
        addQuadratic(control, point);
      }
      continue;
    }

    if (upperCommand === "T") {
      while (index + 1 < tokens.length && hasNumber()) {
        const control = lastQuadraticControl
          ? { x: current.x * 2 - lastQuadraticControl.x, y: current.y * 2 - lastQuadraticControl.y }
          : { ...current };
        const point = absolutePoint(readNumber(), readNumber(), relative);
        addQuadratic(control, point);
      }
      continue;
    }

    if (upperCommand === "A") {
      while (index + 6 < tokens.length && hasNumber()) {
        index += 5;
        const point = absolutePoint(readNumber(), readNumber(), relative);
        addLine(point);
      }
      continue;
    }

    index += 1;
  }

  return commands;
}

function measurePathBounds(shapes) {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const shape of shapes) {
    const padding = (parseCssLengthMm(shape.style["stroke-width"], 0.1) * MM_TO_PT) / 2;
    for (const command of shape.commands) {
      for (const point of getCommandPoints(command)) {
        minX = Math.min(minX, point.x - padding);
        minY = Math.min(minY, point.y - padding);
        maxX = Math.max(maxX, point.x + padding);
        maxY = Math.max(maxY, point.y + padding);
      }
    }
  }

  if (![minX, minY, maxX, maxY].every(Number.isFinite)) {
    return null;
  }

  return {
    minX,
    minY,
    width: Math.max(0.001, maxX - minX),
    height: Math.max(0.001, maxY - minY)
  };
}

function measureDocumentBounds(document) {
  const pathBounds = measurePathBounds(document.shapes) ?? document.bounds;
  let minX = pathBounds.minX;
  let minY = pathBounds.minY;
  let maxX = pathBounds.minX + pathBounds.width;
  let maxY = pathBounds.minY + pathBounds.height;
  for (const label of document.textLabels ?? []) {
    const textWidth = label.advancePt * Array.from(label.text).length;
    const textHeight = label.fontSizePt;
    const points = [
      { x: label.x, y: label.y },
      { x: label.x + textWidth, y: label.y },
      { x: label.x, y: label.y - textHeight },
      { x: label.x + textWidth, y: label.y - textHeight }
    ];
    for (const point of points) {
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }
  }
  return {
    minX,
    minY,
    width: Math.max(0.001, maxX - minX),
    height: Math.max(0.001, maxY - minY)
  };
}

function getCommandPoints(command) {
  if (command.type === "M" || command.type === "L") {
    return [{ x: command.x, y: command.y }];
  }
  if (command.type === "C") {
    return [
      { x: command.x1, y: command.y1 },
      { x: command.x2, y: command.y2 },
      { x: command.x, y: command.y }
    ];
  }
  return [];
}

function resolveLayout(bounds, options = {}) {
  const marginPt = Number(options.marginPt ?? 0);
  const paperSize = normalizePaperSize(options.paperSize);
  const drawingWidthPt = bounds.width;
  const drawingHeightPt = bounds.height;

  if (!paperSize) {
    return {
      type: "single",
      bounds,
      marginPt,
      widthPt: Math.max(72, drawingWidthPt + marginPt * 2),
      heightPt: Math.max(72, drawingHeightPt + marginPt * 2),
      drawingWidthPt,
      drawingHeightPt,
      drawingWidthMm: drawingWidthPt / MM_TO_PT,
      drawingHeightMm: drawingHeightPt / MM_TO_PT
    };
  }

  const orientation = normalizeOrientation(options.orientation);
  const [shortEdgeMm, longEdgeMm] = PAPER_SIZES_MM[paperSize];
  let pageWidthPt = shortEdgeMm * MM_TO_PT;
  let pageHeightPt = longEdgeMm * MM_TO_PT;
  if (orientation === "landscape" || (orientation === "auto" && bounds.width >= bounds.height)) {
    pageWidthPt = longEdgeMm * MM_TO_PT;
    pageHeightPt = shortEdgeMm * MM_TO_PT;
  }

  const tileWidthPt = Math.max(1, pageWidthPt - marginPt * 2);
  const tileHeightPt = Math.max(1, pageHeightPt - marginPt * 2);
  const columns = Math.max(1, Math.ceil(drawingWidthPt / tileWidthPt));
  const rows = Math.max(1, Math.ceil(drawingHeightPt / tileHeightPt));

  return {
    type: "tiled",
    bounds,
    marginPt,
    paperSize,
    orientation: pageWidthPt > pageHeightPt ? "landscape" : "portrait",
    pageWidthPt,
    pageHeightPt,
    tileWidthPt,
    tileHeightPt,
    drawingWidthPt,
    drawingHeightPt,
    drawingWidthMm: drawingWidthPt / MM_TO_PT,
    drawingHeightMm: drawingHeightPt / MM_TO_PT,
    columns,
    rows,
    pageCount: columns * rows
  };
}

function createSinglePage(document, layout) {
  const content = createPageContent(document, {
    pageHeightPt: layout.heightPt,
    drawingHeightPt: layout.drawingHeightPt,
    marginPt: layout.marginPt,
    tileXPt: 0,
    tileYPt: 0,
    clip: null
  });
  return {
    widthPt: layout.widthPt,
    heightPt: layout.heightPt,
    content
  };
}

function createTiledPages(document, layout) {
  const pages = [];
  for (let row = 0; row < layout.rows; row += 1) {
    for (let column = 0; column < layout.columns; column += 1) {
      const tileXPt = column * layout.tileWidthPt;
      const tileYPt = row * layout.tileHeightPt;
      const content = createPageContent(document, {
        pageHeightPt: layout.pageHeightPt,
        drawingHeightPt: layout.drawingHeightPt,
        marginPt: layout.marginPt,
        tileXPt,
        tileYPt,
        clip: {
          x: layout.marginPt,
          y: layout.marginPt,
          width: layout.tileWidthPt,
          height: layout.tileHeightPt
        }
      });
      pages.push({
        widthPt: layout.pageWidthPt,
        heightPt: layout.pageHeightPt,
        content
      });
    }
  }
  return pages;
}

function createPageContent(document, page) {
  const content = ["q"];
  if (page.clip) {
    content.push(`${format(page.clip.x)} ${format(page.clip.y)} ${format(page.clip.width)} ${format(page.clip.height)} re`);
    content.push("W");
    content.push("n");
  }

  let activeStroke = null;
  let activeWidth = null;
  let activeLineCap = null;
  let activeLineJoin = null;
  for (const shape of document.shapes) {
    const stroke = parseRgb(shape.style.stroke);
    if (stroke && (!activeStroke || stroke.some((value, index) => value !== activeStroke[index]))) {
      content.push(`${stroke[0]} ${stroke[1]} ${stroke[2]} RG`);
      activeStroke = stroke;
    }
    const widthPt = parseCssLengthMm(shape.style["stroke-width"], 0.1) * MM_TO_PT;
    if (activeWidth !== widthPt) {
      content.push(`${format(widthPt)} w`);
      activeWidth = widthPt;
    }
    const lineCap = parseSvgLineCap(shape.style["stroke-linecap"]);
    if (activeLineCap !== lineCap) {
      content.push(`${lineCap} J`);
      activeLineCap = lineCap;
    }
    const lineJoin = parseSvgLineJoin(shape.style["stroke-linejoin"]);
    if (activeLineJoin !== lineJoin) {
      content.push(`${lineJoin} j`);
      activeLineJoin = lineJoin;
    }

    for (const command of shape.commands) {
      if (command.type === "Z") {
        content.push("h");
        continue;
      }
      if (command.type === "C") {
        const control1 = transformPoint({ x: command.x1, y: command.y1 }, document.bounds, page);
        const control2 = transformPoint({ x: command.x2, y: command.y2 }, document.bounds, page);
        const point = transformPoint(command, document.bounds, page);
        content.push(`${format(control1.x)} ${format(control1.y)} ${format(control2.x)} ${format(control2.y)} ${format(point.x)} ${format(point.y)} c`);
        continue;
      }
      const point = transformPoint(command, document.bounds, page);
      content.push(`${format(point.x)} ${format(point.y)} ${command.type === "M" ? "m" : "l"}`);
    }
    content.push("S");
  }

  if (document.textLabels?.length) {
    content.push("0 0 0 rg");
    for (const label of document.textLabels) {
      const point = transformPoint(label, document.bounds, page);
      const angle = Math.atan2(label.direction.y, label.direction.x);
      const cos = Math.cos(-angle);
      const sin = Math.sin(-angle);
      content.push("BT");
      content.push(`/F1 ${format(label.fontSizePt)} Tf`);
      content.push(`${format(cos)} ${format(sin)} ${format(-sin)} ${format(cos)} ${format(point.x)} ${format(point.y)} Tm`);
      content.push(`${format(label.advancePt)} 0 Td`);
      content.push(`<${utf16BeHex(label.text)}> Tj`);
      content.push("ET");
    }
  }

  content.push("Q");
  return content.join("\n");
}

function transformPoint(point, bounds, page) {
  const xPt = point.x - bounds.minX;
  const yPt = point.y - bounds.minY;
  return {
    x: page.marginPt + xPt - page.tileXPt,
    y: page.marginPt + page.drawingHeightPt - yPt - page.tileYPt
  };
}

function parseRgb(value) {
  const match = value?.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/i);
  if (!match) return [0, 0, 0];
  return match.slice(1).map((item) => Math.max(0, Math.min(1, Number(item) / 255)));
}

function parseCssLengthMm(value, fallback) {
  const match = value?.match(/(-?(?:\d+\.?\d*|\.\d+))(mm)?/i);
  if (!match) return fallback;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseSvgLineCap(value) {
  const normalized = String(value ?? "butt").trim().toLowerCase();
  if (normalized === "round") return 1;
  if (normalized === "square") return 2;
  return 0;
}

function parseSvgLineJoin(value) {
  const normalized = String(value ?? "miter").trim().toLowerCase();
  if (normalized === "round") return 1;
  if (normalized === "bevel") return 2;
  return 0;
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

function format(value) {
  return Number(value).toFixed(3);
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
  const cidFontObj = addObject(
    objects,
    "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 2 >> /DW 1000 >>"
  );
  const fontObj = addObject(
    objects,
    `<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [${cidFontObj} 0 R] >>`
  );
  const pageEntries = [];
  const pagesObj = addObject(objects, "");

  for (const page of pages) {
    const contentObj = addObject(objects, streamObject(page.content));
    const pageObj = addObject(
      objects,
      `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${format(page.widthPt)} ${format(page.heightPt)}] /Resources << /Font << /F1 ${fontObj} 0 R >> >> /Contents ${contentObj} 0 R >>`
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

function utf8ByteLength(text) {
  if (textEncoder) {
    return textEncoder.encode(text).length;
  }
  return Buffer.byteLength(text, "utf8");
}

function normalizeDirection(direction) {
  const x = Number(direction?.x);
  const y = Number(direction?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y) || (x === 0 && y === 0)) {
    return { x: 1, y: 0 };
  }
  const length = Math.hypot(x, y);
  return { x: x / length, y: y / length };
}

function utf16BeHex(text) {
  const bytes = [];
  for (const char of text) {
    const codePoint = char.codePointAt(0);
    if (codePoint <= 0xffff) {
      bytes.push(codePoint >> 8, codePoint & 0xff);
    } else {
      const adjusted = codePoint - 0x10000;
      const high = 0xd800 + (adjusted >> 10);
      const low = 0xdc00 + (adjusted & 0x3ff);
      bytes.push(high >> 8, high & 0xff, low >> 8, low & 0xff);
    }
  }
  return bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
}
