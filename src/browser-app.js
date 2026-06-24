import { measureDrawing, parseHpgl } from "./core/plt-core.js";
import { sanitizeSvgInnerMarkup } from "./core/svg-sanitize.js";
import { decodePltBuffer } from "./core/text-decoding.js";

const PT_PER_MM = 72 / 25.4;
const MM_PER_PT = 25.4 / 72;
const DEFAULT_FONT_SIZE_PT = 10;

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
  viewport: {
    scale: 1,
    offsetX: 0,
    offsetY: 0
  },
  drag: null,
  isConverting: false,
  convertController: null,
  convertRequestId: 0,
  previewController: null,
  previewRequestId: 0,
  convertJob: null
};

const els = {
  form: document.querySelector("#controls"),
  file: document.querySelector("#file-input"),
  dropzone: document.querySelector("#dropzone"),
  dropzoneTitle: document.querySelector("#dropzone-title"),
  dropzoneDescription: document.querySelector("#dropzone-description"),
  status: document.querySelector("#status"),
  meta: document.querySelector("#meta"),
  pageCount: document.querySelector("#page-count"),
  editor: document.querySelector("#editor"),
  download: document.querySelector("#download"),
  convert: document.querySelector("#convert"),
  clear: document.querySelector("#clear"),
  units: document.querySelector("#units"),
  margin: document.querySelector("#margin"),
  lineWidth: document.querySelector("#line-width"),
  paperSize: document.querySelector("#paper-size"),
  orientation: document.querySelector("#orientation")
};

bindEvents();
renderUploadPrompt();
renderEmptyState();
renderConvertButton();

function bindEvents() {
  els.file.addEventListener("change", onFilePicked);
  els.clear.addEventListener("click", onClear);
  els.form.addEventListener("submit", async (event) => {
    event.preventDefault();
    await runConvert();
  });
  els.editor.addEventListener("wheel", onEditorWheel, { passive: false });
  els.editor.addEventListener("pointerdown", onEditorPointerDown);
  els.editor.addEventListener("pointermove", onEditorPointerMove);
  els.editor.addEventListener("pointerup", onEditorPointerUp);
  els.editor.addEventListener("pointercancel", onEditorPointerUp);

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
    input.addEventListener("input", async () => {
      if (state.sourceBase64) {
        state.previewSvg = "";
        state.previewViewBox = null;
        resetConversionResult();
        updateMeta();
        renderPreviewLoadingState();
        await runPreview();
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
  state.drawing = parseHpglSafely(state.source);
  state.previewSvg = "";
  state.previewViewBox = null;
  resetViewport();
  renderUploadPrompt();
  if (!state.isConverting) {
    els.status.textContent = `已加载：${file.name}`;
  }
  updateMeta();
  resetConversionResult();
  renderPreviewLoadingState();
  await runPreview();
}

async function runConvert() {
  if (!state.sourceBase64 || state.isConverting) return;
  const requestId = state.convertRequestId + 1;
  state.convertRequestId = requestId;
  state.convertController?.abort();
  state.convertController = new AbortController();
  state.isConverting = true;
  state.convertJob = null;
  renderConvertButton();
  try {
    await onConvert(requestId, state.convertController.signal);
  } catch (error) {
    if (error?.name === "AbortError") return;
    els.status.textContent = "转换失败";
    els.meta.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    if (state.convertRequestId === requestId) {
      state.convertController = null;
      state.isConverting = false;
      renderConvertButton();
    }
  }
}

function onClear() {
  state.file = null;
  state.source = "";
  state.sourceBase64 = "";
  state.drawing = null;
  state.previewSvg = "";
  state.previewViewBox = null;
  state.convertJob = null;
  resetViewport();
  cancelPendingConvert();
  state.isConverting = false;
  renderConvertButton();
  els.file.value = "";
  renderUploadPrompt();
  els.status.textContent = "未加载文件";
  els.meta.textContent = "拖放 .plt 文件或从磁盘选择一个文件。";
  clearPageCount();
  cleanupPdfUrl();
  resetDownloadLink();
  renderEmptyState();
}

async function onConvert(requestId, signal) {
  if (!state.sourceBase64) return;
  const options = readOptions();
  els.status.textContent = "正在提交转换任务...";
  const initialJob = await submitConvertJob(options, signal);
  if (state.convertRequestId !== requestId) return;
  await monitorConvertJob(initialJob, options, requestId, signal);
}

async function runPreview() {
  if (!state.sourceBase64) return;
  const requestId = state.previewRequestId + 1;
  state.previewRequestId = requestId;
  state.previewController?.abort();
  state.previewController = new AbortController();
  try {
    if (!state.isConverting) {
      els.status.textContent = `已加载：${state.file?.name ?? "文件"}，正在生成预览...`;
    }
    const result = await previewOnServer(readOptions(), state.previewController.signal);
    if (state.previewRequestId !== requestId) return;
    state.previewSvg = result.svgBase64 ? decodeBase64Text(result.svgBase64) : "";
    state.previewViewBox = parseSvgViewBox(state.previewSvg);
    if (!state.previewSvg || !state.previewViewBox) {
      if (!state.isConverting) {
        els.status.textContent = "预览失败";
      }
      els.editor.innerHTML = '<div class="editor-empty">没有生成可预览的 SVG，请检查 PLT 文件内容。</div>';
      return;
    }
    renderEditor();
    const pageCount = getPdfPageCount(result.layout);
    renderPageCount(pageCount);
    if (!state.isConverting) {
      els.status.textContent = `已加载：${state.file?.name ?? "文件"}，点击开始转换`;
    }
  } catch (error) {
    if (error?.name === "AbortError") return;
    if (!state.isConverting) {
      els.status.textContent = "预览失败";
    }
    els.meta.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    if (state.previewRequestId === requestId) {
      state.previewController = null;
    }
  }
}

async function previewOnServer(options, signal) {
  const response = await fetch("/api/preview", {
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

async function submitConvertJob(options, signal) {
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

async function fetchJobStatus(jobId, signal) {
  const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`, {
    signal
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(formatConvertError(response.status, result.error));
  }
  return result;
}

async function monitorConvertJob(job, options, requestId, signal) {
  let currentJob = job;
  while (state.convertRequestId === requestId) {
    state.convertJob = currentJob;
    renderConvertButton();
    if (currentJob.status === "queued") {
      els.status.textContent = currentJob.aheadCount > 0
        ? `转换任务已排队，前面还有 ${currentJob.aheadCount} 个任务`
        : "转换任务已排队";
      els.meta.textContent = `队列中 ${currentJob.pending} 个任务 · 当前 ${currentJob.active} 个正在处理`;
    } else if (currentJob.status === "running") {
      els.status.textContent = "正在转换 PDF，请稍候...";
      els.meta.textContent = `队列中 ${currentJob.pending} 个任务 · 当前 ${currentJob.active} 个正在处理`;
    } else if (currentJob.status === "done") {
      finalizeConvertJob(currentJob, options);
      return;
    } else if (currentJob.status === "error") {
      throw new Error(currentJob.error || "转换失败");
    }
    await sleep(1000, signal);
    currentJob = await fetchJobStatus(currentJob.jobId, signal);
  }
}

function finalizeConvertJob(result, options) {
  const blob = pdfResultToBlob(result);
  const url = URL.createObjectURL(blob);
  cleanupPdfUrl();
  state.previewSvg = getResultSvgText(result);
  state.previewViewBox = parseSvgViewBox(state.previewSvg);
  state.pdfUrl = url;
  const pageCount = getPdfPageCount(result.layout);
  els.status.textContent = "转换成功";
  els.meta.textContent = `${state.file?.name ?? "文件"} · PDF ${formatSize(blob.size)} · ${formatServerLayoutSummary(result.layout)} · 边距 ${formatMm(options.marginMm)} mm`;
  renderPageCount(pageCount);
  renderDownloadLink(url);
  renderEditor();
}

function cancelPendingConvert() {
  state.convertController?.abort();
  state.convertController = null;
  state.convertRequestId += 1;
  state.isConverting = false;
  renderConvertButton();
  state.previewController?.abort();
  state.previewController = null;
  state.previewRequestId += 1;
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

function updateMeta() {
  if (!state.file) return;
  if (!state.drawing) {
    els.meta.textContent = `${state.file.name} · 输入 ${formatSize(state.file.size)}`;
    return;
  }
  const options = readOptions();
  const metrics = measureDrawing(
    state.drawing,
    options.unitsPerInch,
    options.fontSizePt,
    options.lineWidthPt
  );
  els.meta.textContent = `${state.file.name} · ${state.drawing.shapes.length} 个图形 · 输入 ${formatSize(state.file.size)} · ${Math.round(metrics.width)} × ${Math.round(metrics.height)} 单位`;
}

function renderEmptyState() {
  els.editor.innerHTML = '<div class="editor-empty">加载 .plt 文件后，可滚轮缩放、按住拖动预览。</div>';
}

function renderPreviewLoadingState() {
  els.editor.innerHTML = '<div class="editor-empty">正在生成 PLT 预览...</div>';
}

function renderUploadPrompt() {
  if (state.file) {
    els.dropzoneTitle.textContent = state.file.name;
    els.dropzoneDescription.textContent = "已选择文件，可点击或拖入新文件替换";
    return;
  }
  els.dropzoneTitle.textContent = "把 .plt 文件拖到这里";
  els.dropzoneDescription.textContent = "或者点击选择文件";
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
    options.lineWidthPt
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
      const strokeWidthUnits = getShapeLineWidthUnits(shape, scale, options.lineWidthPt);
      const d = pointsToPathData(shape.points);
      if (!d) continue;
      shapesMarkup.push(
        `<path d="${d}" fill="none" stroke="${strokeColor}" stroke-width="${strokeWidthUnits.toFixed(3)}" stroke-linecap="round" stroke-linejoin="round" />`
      );
    } else if (shape.type === "circle") {
      const strokeColor = getPenColor(shape.pen);
      const strokeWidthUnits = getShapeLineWidthUnits(shape, scale, options.lineWidthPt);
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

function formatServerLayoutSummary(layout) {
  const size = layout?.drawingWidthMm && layout?.drawingHeightMm
    ? `图形 ${layout.drawingWidthMm.toFixed(0)} × ${layout.drawingHeightMm.toFixed(0)} mm · `
    : "";
  if (!layout || layout.type !== "tiled") {
    return `${size}单页自适应`;
  }
  return `${size}${layout.paperSize} ${layout.orientation === "landscape" ? "横向" : "竖向"} · ${layout.columns} × ${layout.rows} 页 · 共 ${layout.pageCount} 页`;
}

function getPdfPageCount(layout) {
  if (Number.isInteger(layout?.pageCount) && layout.pageCount > 0) {
    return layout.pageCount;
  }
  return 1;
}

function formatPdfPageCount(pageCount) {
  return `预计 ${pageCount} 张`;
}

function renderPageCount(pageCount) {
  els.pageCount.hidden = false;
  els.pageCount.textContent = `PDF 张数：${formatPdfPageCount(pageCount)}`;
}

function clearPageCount() {
  els.pageCount.hidden = true;
  els.pageCount.textContent = "";
}

function renderDownloadLink(url) {
  els.download.hidden = false;
  els.download.href = url;
  els.download.download = `${stripExtension(state.file?.name ?? "output")}.pdf`;
}

function resetDownloadLink() {
  els.download.hidden = true;
  els.download.removeAttribute("href");
  els.download.removeAttribute("download");
}

function resetConversionResult() {
  cancelPendingConversion();
  cleanupPdfUrl();
  clearPageCount();
  resetDownloadLink();
  state.convertJob = null;
  if (!state.isConverting) {
    els.status.textContent = state.file
      ? `已加载：${state.file.name}，点击开始转换`
      : "未加载文件";
  }
}

function cancelPendingConversion() {
  state.convertController?.abort();
  state.convertController = null;
  state.convertRequestId += 1;
  state.isConverting = false;
  state.convertJob = null;
  renderConvertButton();
}

function renderConvertButton() {
  const disabled = state.isConverting || !state.sourceBase64;
  const label = state.isConverting
    ? (state.convertJob?.status === "queued" ? "排队中..." : "转换中...")
    : "开始转换";
  els.convert.disabled = disabled;
  els.convert.classList.toggle("is-loading", state.isConverting);
  els.convert.setAttribute("aria-busy", state.isConverting ? "true" : "false");
  els.convert.textContent = label;
}

function getShapeLineWidthUnits(shape, scale, fallbackLineWidthPt) {
  if (Number.isFinite(shape.lineWidthUnits)) {
    return Math.max(shape.lineWidthUnits, 0.01);
  }
  return Math.max(fallbackLineWidthPt / scale, 0.01);
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
  if (status === 404) return "转换任务已过期，请重新提交。";
  if (status === 504) return "转换超时，请尝试简化文件或稍后重试。";
  return "转换失败";
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function pdfResultToBlob(result) {
  if (typeof result?.pdfBase64 === "string") {
    return base64ToBlob(result.pdfBase64, "application/pdf");
  }
  if (typeof result?.pdf === "string") {
    return new Blob([stringToBytes(result.pdf)], { type: "application/pdf" });
  }
  throw new Error("转换结果缺少 PDF 数据");
}

function getResultSvgText(result) {
  if (typeof result?.svgBase64 === "string") {
    return decodeBase64Text(result.svgBase64);
  }
  if (typeof result?.svg === "string") {
    return result.svg;
  }
  return "";
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("The operation was aborted.", "AbortError"));
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
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

function stringToBytes(text) {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) {
    bytes[i] = text.charCodeAt(i) & 0xff;
  }
  return bytes;
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
  return sanitizeSvgInnerMarkup(svg);
}

function decodePltText(buffer) {
  return decodePltBuffer(buffer);
}

function parseHpglSafely(source) {
  try {
    return parseHpgl(source);
  } catch {
    return null;
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
