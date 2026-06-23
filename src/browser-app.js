import { convertDrawingToPdf, getTiledPdfLayout, measureDrawing, parseHpgl } from "./core/plt-core.js";

const PT_PER_MM = 72 / 25.4;
const MM_PER_PT = 25.4 / 72;
const DEFAULT_FONT_SIZE_PT = 10;
const CONVERT_DEBOUNCE_MS = 800;

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

const state = {
  file: null,
  source: "",
  sourceBase64: "",
  drawing: null,
  previewSvg: "",
  previewViewBox: null,
  pdfUrl: null,
  sampleUrl: null,
  selectedShapeId: null,
  shapeLineWidthOverrides: {},
  viewport: {
    scale: 1,
    offsetX: 0,
    offsetY: 0
  },
  drag: null,
  convertTimer: null,
  convertController: null,
  convertRequestId: 0
};

const els = {
  form: document.querySelector("#controls"),
  file: document.querySelector("#file-input"),
  dropzone: document.querySelector("#dropzone"),
  status: document.querySelector("#status"),
  meta: document.querySelector("#meta"),
  editor: document.querySelector("#editor"),
  openPreview: document.querySelector("#open-preview"),
  download: document.querySelector("#download"),
  sampleDownload: document.querySelector("#sample-download"),
  convert: document.querySelector("#convert"),
  clear: document.querySelector("#clear"),
  units: document.querySelector("#units"),
  margin: document.querySelector("#margin"),
  lineWidth: document.querySelector("#line-width"),
  paperSize: document.querySelector("#paper-size"),
  orientation: document.querySelector("#orientation"),
  selectionInfo: document.querySelector("#selection-info"),
  selectedLineWidth: document.querySelector("#selected-line-width"),
  thickenLine: document.querySelector("#thicken-line"),
  resetLine: document.querySelector("#reset-line")
};

bindEvents();
initSampleDownload();
renderEmptyState();
renderSelectionPanel();

function bindEvents() {
  els.file.addEventListener("change", onFilePicked);
  els.clear.addEventListener("click", onClear);
  els.form.addEventListener("submit", async (event) => {
    event.preventDefault();
    await runConvert();
  });
  els.editor.addEventListener("click", onEditorClick);
  els.editor.addEventListener("wheel", onEditorWheel, { passive: false });
  els.editor.addEventListener("pointerdown", onEditorPointerDown);
  els.editor.addEventListener("pointermove", onEditorPointerMove);
  els.editor.addEventListener("pointerup", onEditorPointerUp);
  els.editor.addEventListener("pointercancel", onEditorPointerUp);
  els.selectedLineWidth.addEventListener("input", onSelectedWidthInput);
  els.thickenLine.addEventListener("click", onThickenLine);
  els.resetLine.addEventListener("click", onResetLine);

  els.dropzone.addEventListener("dragover", (event) => {
    event.preventDefault();
    els.dropzone.classList.add("is-dragover");
  });
  els.dropzone.addEventListener("dragleave", () => {
    els.dropzone.classList.remove("is-dragover");
  });
  els.dropzone.addEventListener("drop", async (event) => {
    event.preventDefault();
    els.dropzone.classList.remove("is-dragover");
    const [file] = event.dataTransfer.files;
    if (file) {
      await loadFile(file);
    }
  });

  for (const input of [els.units, els.margin, els.lineWidth, els.paperSize, els.orientation]) {
    input.addEventListener("input", () => {
      if (state.drawing) {
        renderEditor();
        renderSelectionPanel();
        scheduleConvert();
      }
    });
  }
}

async function onFilePicked(event) {
  const [file] = event.target.files;
  if (file) {
    await loadFile(file);
  }
}

async function loadFile(file) {
  state.file = file;
  const buffer = await file.arrayBuffer();
  state.sourceBase64 = arrayBufferToBase64(buffer);
  state.source = decodePltText(buffer);
  state.drawing = parseHpgl(state.source);
  state.previewSvg = "";
  state.previewViewBox = null;
  state.selectedShapeId = findFirstSelectableShapeId(state.drawing);
  state.shapeLineWidthOverrides = {};
  resetViewport();
  els.status.textContent = `已加载：${file.name}`;
  updateMeta();
  renderLoadingState();
  renderSelectionPanel();
  await runConvert();
}

async function runConvert() {
  if (state.convertTimer) {
    clearTimeout(state.convertTimer);
    state.convertTimer = null;
  }
  const requestId = state.convertRequestId + 1;
  state.convertRequestId = requestId;
  state.convertController?.abort();
  state.convertController = new AbortController();
  try {
    await onConvert(requestId, state.convertController.signal);
  } catch (error) {
    if (error?.name === "AbortError") return;
    els.status.textContent = "转换失败";
    els.meta.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    if (state.convertRequestId === requestId) {
      state.convertController = null;
    }
  }
}

function scheduleConvert() {
  if (state.convertTimer) {
    clearTimeout(state.convertTimer);
  }
  els.status.textContent = "等待参数稳定后转换...";
  state.convertTimer = setTimeout(() => {
    state.convertTimer = null;
    runConvert();
  }, CONVERT_DEBOUNCE_MS);
}

function onClear() {
  state.file = null;
  state.source = "";
  state.sourceBase64 = "";
  state.drawing = null;
  state.previewSvg = "";
  state.previewViewBox = null;
  state.selectedShapeId = null;
  state.shapeLineWidthOverrides = {};
  resetViewport();
  cancelPendingConvert();
  els.file.value = "";
  els.status.textContent = "未加载文件";
  els.meta.textContent = "拖放 .plt 文件或从磁盘选择一个文件。";
  cleanupPdfUrl();
  els.openPreview.href = "#";
  els.download.href = "#";
  renderEmptyState();
  renderSelectionPanel();
}

async function onConvert(requestId, signal) {
  if (!state.sourceBase64) return;
  const options = readOptions();
  els.status.textContent = "正在使用 hp2xx 转换...";
  const result = await convertOnServer(options, signal);
  if (state.convertRequestId !== requestId) return;
  const blob = base64ToBlob(result.pdfBase64, "application/pdf");
  const url = URL.createObjectURL(blob);
  cleanupPdfUrl();
  state.previewSvg = result.svgBase64 ? decodeBase64Text(result.svgBase64) : "";
  state.previewViewBox = parseSvgViewBox(state.previewSvg);
  state.pdfUrl = url;
  els.openPreview.href = url;
  els.download.href = url;
  els.download.download = `${stripExtension(state.file?.name ?? "output")}.pdf`;
  els.status.textContent = `已转换：${state.file?.name ?? "文件"}`;
  els.meta.textContent = `${state.file?.name ?? "文件"} · PDF ${formatSize(blob.size)} · ${formatServerLayoutSummary(result.layout)} · 边距 ${formatMm(options.marginMm)} mm`;
  renderEditor();
  renderSelectionPanel();
}

async function convertOnServer(options, signal) {
  const response = await fetch("/api/convert", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    signal,
    body: JSON.stringify({
      sourceBase64: state.sourceBase64,
      paperSize: options.paperSize,
      orientation: options.orientation,
      marginPt: options.marginPt,
      lineWidthMm: options.lineWidthMm,
      unitsPerInch: options.unitsPerInch
    })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(formatConvertError(response.status, result.error));
  }
  return result;
}

function cancelPendingConvert() {
  if (state.convertTimer) {
    clearTimeout(state.convertTimer);
    state.convertTimer = null;
  }
  state.convertController?.abort();
  state.convertController = null;
  state.convertRequestId += 1;
}

function onEditorClick(event) {
  if (state.drag?.didMove) return;
  const target = event.target.closest?.("[data-shape-id]");
  if (!target) return;
  const shapeId = target.getAttribute("data-shape-id");
  const shape = findShapeById(shapeId);
  if (!shape || !isSelectableShape(shape)) return;
  state.selectedShapeId = shapeId;
  renderSelectionPanel();
  renderEditor();
}

function onEditorWheel(event) {
  if (!hasPreview()) return;
  event.preventDefault();
  const rect = els.editor.getBoundingClientRect();
  const pointerX = event.clientX - rect.left;
  const pointerY = event.clientY - rect.top;
  const previousScale = state.viewport.scale;
  const zoomFactor = Math.exp(-event.deltaY * 0.001);
  const nextScale = clamp(previousScale * zoomFactor, 0.2, 12);
  if (nextScale === previousScale) return;

  state.viewport.offsetX = pointerX - (pointerX - state.viewport.offsetX) * (nextScale / previousScale);
  state.viewport.offsetY = pointerY - (pointerY - state.viewport.offsetY) * (nextScale / previousScale);
  state.viewport.scale = nextScale;
  renderEditor();
}

function onEditorPointerDown(event) {
  if (!hasPreview() || event.button !== 0) return;
  els.editor.setPointerCapture?.(event.pointerId);
  state.drag = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    lastX: event.clientX,
    lastY: event.clientY,
    didMove: false
  };
  els.editor.classList.add("is-panning");
}

function onEditorPointerMove(event) {
  const drag = state.drag;
  if (!drag || drag.pointerId !== event.pointerId) return;
  const dx = event.clientX - drag.lastX;
  const dy = event.clientY - drag.lastY;
  const totalDx = event.clientX - drag.startX;
  const totalDy = event.clientY - drag.startY;
  if (Math.hypot(totalDx, totalDy) > 3) {
    drag.didMove = true;
  }
  if (drag.didMove) {
    state.viewport.offsetX += dx;
    state.viewport.offsetY += dy;
    renderEditor();
  }
  drag.lastX = event.clientX;
  drag.lastY = event.clientY;
}

function onEditorPointerUp(event) {
  const drag = state.drag;
  if (!drag || drag.pointerId !== event.pointerId) return;
  els.editor.releasePointerCapture?.(event.pointerId);
  els.editor.classList.remove("is-panning");
  setTimeout(() => {
    if (state.drag === drag) {
      state.drag = null;
    }
  }, 0);
}

function onSelectedWidthInput() {
  if (!state.selectedShapeId) return;
  const valueMm = Number(els.selectedLineWidth.value);
  if (!Number.isFinite(valueMm) || valueMm <= 0) return;
  state.shapeLineWidthOverrides[state.selectedShapeId] = mmToPt(valueMm);
  renderEditor();
  renderSelectionPanel();
  runConvert();
}

function onThickenLine() {
  const shape = getSelectedShape();
  if (!shape) return;
  const currentWidthPt = getEffectiveShapeLineWidthPt(shape);
  state.shapeLineWidthOverrides[shape.id] = Math.max(currentWidthPt * 2, 0.1);
  renderEditor();
  renderSelectionPanel();
  runConvert();
}

function onResetLine() {
  const shape = getSelectedShape();
  if (!shape) return;
  delete state.shapeLineWidthOverrides[shape.id];
  renderEditor();
  renderSelectionPanel();
  runConvert();
}

function updateMeta() {
  if (!state.drawing || !state.file) return;
  const options = readOptions();
  const metrics = measureDrawing(
    state.drawing,
    options.unitsPerInch,
    options.fontSizePt,
    options.lineWidthPt,
    state.shapeLineWidthOverrides
  );
  els.meta.textContent = `${state.file.name} · ${state.drawing.shapes.length} 个图形 · 输入 ${formatSize(state.file.size)} · ${Math.round(metrics.width)} × ${Math.round(metrics.height)} 单位`;
}

function renderEmptyState() {
  els.editor.innerHTML = '<div class="editor-empty">加载 .plt 文件后，可滚轮缩放、按住拖动预览。</div>';
}

function renderLoadingState() {
  els.editor.innerHTML = '<div class="editor-empty">正在生成 PLT 预览...</div>';
}

function renderEditor() {
  if (!hasPreview()) {
    renderEmptyState();
    return;
  }

  if (state.previewSvg && state.previewViewBox) {
    renderServerSvgPreview();
    return;
  }

  const options = readOptions();
  const metrics = measureDrawing(
    state.drawing,
    options.unitsPerInch,
    options.fontSizePt,
    options.lineWidthPt,
    state.shapeLineWidthOverrides
  );
  const width = Math.max(metrics.width, 1);
  const height = Math.max(metrics.height, 1);
  const viewBox = `${metrics.minX} ${metrics.minY} ${width} ${height}`;
  const scale = 72 / options.unitsPerInch;
  const viewportTransform = getViewportTransform(metrics);

  const shapesMarkup = [];
  for (const shape of state.drawing.shapes) {
    if (shape.type === "path") {
      const strokeColor = getPenColor(shape.pen);
      const strokeWidthUnits = getEffectiveShapeLineWidthUnits(shape, scale);
      const d = pointsToPathData(shape.points);
      if (!d) continue;
      if (shape.id === state.selectedShapeId) {
        shapesMarkup.push(
          `<path class="shape-selected-outline" d="${d}" stroke-width="${Math.max(strokeWidthUnits + 10, 12)}" />`
        );
      }
      shapesMarkup.push(
        `<path data-shape-id="${shape.id}" class="shape-hit" d="${d}" stroke-width="${Math.max(strokeWidthUnits + 20, 24)}" />`
      );
      shapesMarkup.push(
        `<path d="${d}" fill="none" stroke="${strokeColor}" stroke-width="${strokeWidthUnits.toFixed(3)}" stroke-linecap="round" stroke-linejoin="round" />`
      );
    } else if (shape.type === "circle") {
      const strokeColor = getPenColor(shape.pen);
      const strokeWidthUnits = getEffectiveShapeLineWidthUnits(shape, scale);
      if (shape.id === state.selectedShapeId) {
        shapesMarkup.push(
          `<circle class="shape-selected-outline" cx="${shape.center.x}" cy="${shape.center.y}" r="${shape.radius}" stroke-width="${Math.max(strokeWidthUnits + 10, 12)}" />`
        );
      }
      shapesMarkup.push(
        `<circle data-shape-id="${shape.id}" class="shape-hit" cx="${shape.center.x}" cy="${shape.center.y}" r="${shape.radius}" stroke-width="${Math.max(strokeWidthUnits + 20, 24)}" />`
      );
      shapesMarkup.push(
        `<circle cx="${shape.center.x}" cy="${shape.center.y}" r="${shape.radius}" fill="none" stroke="${strokeColor}" stroke-width="${strokeWidthUnits.toFixed(3)}" />`
      );
    } else if (shape.type === "text") {
      shapesMarkup.push(renderTextShape(shape, scale));
    }
  }

  els.editor.innerHTML = `
    <svg viewBox="${viewBox}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="PLT 编辑预览">
      <g transform="${viewportTransform}">
        ${shapesMarkup.join("")}
      </g>
    </svg>
  `;
}

function renderServerSvgPreview() {
  const viewBox = state.previewViewBox;
  const innerMarkup = getSvgInnerMarkup(state.previewSvg);
  const metrics = {
    minX: viewBox.x,
    minY: viewBox.y,
    width: viewBox.width,
    height: viewBox.height
  };
  const viewportTransform = getViewportTransform(metrics);
  els.editor.innerHTML = `
    <svg viewBox="${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="PLT 预览" xmlns="http://www.w3.org/2000/svg">
      <g transform="${viewportTransform}">
        ${innerMarkup}
      </g>
    </svg>
  `;
}

function getViewportTransform(metrics) {
  const rect = els.editor.getBoundingClientRect();
  const viewWidth = Math.max(metrics.width, 1);
  const viewHeight = Math.max(metrics.height, 1);
  const unitsPerPixel = Math.max(viewWidth / Math.max(rect.width, 1), viewHeight / Math.max(rect.height, 1));
  const scale = state.viewport.scale;
  const offsetX = state.viewport.offsetX * unitsPerPixel;
  const offsetY = state.viewport.offsetY * unitsPerPixel;
  const centerX = metrics.minX + viewWidth / 2;
  const centerY = metrics.minY + viewHeight / 2;
  return `translate(${offsetX.toFixed(3)} ${offsetY.toFixed(3)}) translate(${centerX.toFixed(3)} ${centerY.toFixed(3)}) scale(${scale.toFixed(4)}) translate(${(-centerX).toFixed(3)} ${(-centerY).toFixed(3)})`;
}

function resetViewport() {
  state.viewport = {
    scale: 1,
    offsetX: 0,
    offsetY: 0
  };
  state.drag = null;
}

function hasPreview() {
  return Boolean((state.previewSvg && state.previewViewBox) || state.drawing);
}

function renderSelectionPanel() {
  if (state.previewSvg) {
    els.selectedLineWidth.disabled = true;
    els.thickenLine.disabled = true;
    els.resetLine.disabled = true;
    els.selectionInfo.textContent = "当前预览使用 hp2xx 渲染；请用上方全局线宽调整预览和 PDF。";
    els.selectedLineWidth.value = "";
    return;
  }

  const shape = getSelectedShape();
  const enabled = Boolean(shape);
  els.selectedLineWidth.disabled = !enabled;
  els.thickenLine.disabled = !enabled;
  els.resetLine.disabled = !enabled;

  if (!shape) {
    els.selectionInfo.textContent = "点击右侧预览中的一根线条，再调整线宽。";
    els.selectedLineWidth.value = "";
    return;
  }

  const currentWidthPt = getEffectiveShapeLineWidthPt(shape);
  const originalWidthPt = getOriginalShapeLineWidthPt(shape);
  els.selectionInfo.textContent = `已选中 ${shape.id} · 当前 ${formatMm(ptToMm(currentWidthPt))} mm · 原始 ${formatMm(ptToMm(originalWidthPt))} mm`;
  els.selectedLineWidth.value = formatMm(ptToMm(currentWidthPt));
}

function readOptions() {
  const marginMm = Number(els.margin.value);
  const lineWidthMm = Number(els.lineWidth.value);
  return {
    unitsPerInch: Number(els.units.value),
    marginMm,
    lineWidthMm,
    marginPt: mmToPt(marginMm),
    lineWidthPt: mmToPt(lineWidthMm),
    fontSizePt: DEFAULT_FONT_SIZE_PT,
    paperSize: els.paperSize.value || "A4",
    orientation: els.orientation.value
  };
}

function formatLayoutSummary(drawing, options) {
  const layout = getTiledPdfLayout(drawing, {
    ...options,
    shapeLineWidthOverrides: state.shapeLineWidthOverrides
  });
  if (layout.type !== "tiled") {
    return "单页自适应";
  }
  return `${layout.paperSize} ${layout.orientation === "landscape" ? "横向" : "竖向"} · ${layout.columns} × ${layout.rows} 页 · 共 ${layout.pageCount} 页`;
}

function formatServerLayoutSummary(layout) {
  const size = layout?.drawingWidthMm && layout?.drawingHeightMm
    ? `图形 ${layout.drawingWidthMm.toFixed(0)} × ${layout.drawingHeightMm.toFixed(0)} mm · `
    : "";
  if (!layout || layout.type !== "tiled") {
    return `${size}单页自适应`;
  }
  return `${size}${layout.paperSize} ${layout.orientation === "landscape" ? "横向" : "竖向"} · ${layout.columns} × ${layout.rows} 页 · 共 ${layout.pageCount} 页`;
}

function getSelectedShape() {
  return findShapeById(state.selectedShapeId);
}

function getOriginalShapeLineWidthPt(shape) {
  const scale = 72 / Number(els.units.value);
  if (Number.isFinite(shape.lineWidthUnits)) {
    return Math.max(shape.lineWidthUnits * scale, 0.01);
  }
  return mmToPt(Number(els.lineWidth.value));
}

function getEffectiveShapeLineWidthPt(shape) {
  const override = state.shapeLineWidthOverrides[shape.id];
  if (Number.isFinite(override)) {
    return Math.max(override, 0.01);
  }
  return getOriginalShapeLineWidthPt(shape);
}

function getEffectiveShapeLineWidthUnits(shape, scale) {
  return Math.max(getEffectiveShapeLineWidthPt(shape) / scale, 0.01);
}

function findShapeById(shapeId) {
  if (!state.drawing || !shapeId) return null;
  return state.drawing.shapes.find((shape) => shape.id === shapeId) ?? null;
}

function findFirstSelectableShapeId(drawing) {
  const shape = drawing?.shapes.find((item) => isSelectableShape(item));
  return shape?.id ?? null;
}

function isSelectableShape(shape) {
  return shape?.type === "path" || shape?.type === "circle";
}

function pointsToPathData(points) {
  if (!points || points.length < 2) return "";
  const [first, ...rest] = points;
  const commands = [`M ${first.x} ${first.y}`];
  for (const point of rest) {
    commands.push(`L ${point.x} ${point.y}`);
  }
  return commands.join(" ");
}

function renderTextShape(shape, scale) {
  const fontSize = Math.max((shape.fontSizePt ?? DEFAULT_FONT_SIZE_PT) / scale, 0.01);
  const x = shape.point.x;
  const y = shape.point.y;
  return `<text x="${x}" y="${y}" font-size="${fontSize}" fill="${getPenColor(shape.pen)}">${escapeHtml(shape.text)}</text>`;
}

function getPenColor(pen) {
  const color = PEN_COLORS[pen % PEN_COLORS.length] ?? PEN_COLORS[0];
  return `rgb(${Math.round(color[0] * 255)} ${Math.round(color[1] * 255)} ${Math.round(color[2] * 255)})`;
}

function cleanupPdfUrl() {
  if (state.pdfUrl) {
    URL.revokeObjectURL(state.pdfUrl);
    state.pdfUrl = null;
  }
}

function initSampleDownload() {
  const sampleSource = [
    "IN;",
    "SP1;",
    "PW5;",
    "PU100,100;",
    "PD500,100;",
    "PU100,150;",
    "PW80;",
    "PD500,150;",
    ""
  ].join("\n");
  const blob = new Blob([sampleSource], { type: "text/plain" });
  state.sampleUrl = URL.createObjectURL(blob);
  els.sampleDownload.href = state.sampleUrl;
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function mmToPt(value) {
  return Number.isFinite(value) ? value * PT_PER_MM : 0;
}

function ptToMm(value) {
  return Number.isFinite(value) ? value * MM_PER_PT : 0;
}

function formatMm(value) {
  return Number(value).toFixed(3).replace(/\.?0+$/, "");
}

function formatConvertError(status, message) {
  if (message) return message;
  if (status === 413) return "文件过大，请上传更小的 PLT 文件。";
  if (status === 429) return "转换任务较多，请稍后再试。";
  if (status === 504) return "转换超时，请尝试简化文件或稍后重试。";
  return "转换失败";
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function base64ToBlob(base64, type) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type });
}

function decodeBase64Text(base64) {
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  return new TextDecoder("utf-8").decode(bytes);
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function parseSvgViewBox(svg) {
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  const svgElement = doc.documentElement?.localName === "svg" ? doc.documentElement : doc.querySelector("svg");
  const rawViewBox = svgElement?.getAttribute("viewBox");
  if (!rawViewBox) return null;
  const [x, y, width, height] = rawViewBox
    .trim()
    .split(/[\s,]+/)
    .map((value) => Number(value));
  if (![x, y, width, height].every((value) => Number.isFinite(value)) || width <= 0 || height <= 0) {
    return null;
  }
  return { x, y, width, height };
}

function getSvgInnerMarkup(svg) {
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  const svgElement = doc.documentElement?.localName === "svg" ? doc.documentElement : doc.querySelector("svg");
  if (!svgElement) return "";
  for (const element of svgElement.querySelectorAll("script, foreignObject")) {
    element.remove();
  }
  return svgElement.innerHTML;
}

function decodePltText(buffer) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    try {
      return new TextDecoder("gb18030").decode(buffer);
    } catch {
      return new TextDecoder("latin1").decode(buffer);
    }
  }
}

function stripExtension(name) {
  return name.replace(/\.[^.]+$/, "");
}

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
