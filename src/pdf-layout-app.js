import * as pdfjsLib from "/vendor/pdfjs/pdf.mjs";
import { buildPdfLayout, DEFAULT_PAGE_GAP_PX, PAGE_SHADOW_MARGIN_PX } from "./core/pdf-layout.js";

const RENDER_SCALE = 2;
const MAX_RENDERED_PIXELS = 90_000_000;
const MAX_PAGE_COUNT = 200;
const EXPORT_PIXEL_RATIO = 2;
const EMPTY_BOUNDS = { width: 1, height: 1 };
const CONTENT_THRESHOLD = 245;
const CONTENT_ALPHA_THRESHOLD = 16;

pdfjsLib.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.mjs";

const state = {
  file: null,
  pdfDocument: null,
  pages: [],
  layout: null,
  stage: null,
  layer: null,
  stageWrap: null,
  isRendering: false,
  renderToken: 0
};

const els = {
  form: document.querySelector("#controls"),
  file: document.querySelector("#file-input"),
  dropzone: document.querySelector("#dropzone"),
  dropzoneTitle: document.querySelector("#dropzone-title"),
  dropzoneDescription: document.querySelector("#dropzone-description"),
  status: document.querySelector("#status"),
  meta: document.querySelector("#meta"),
  editor: document.querySelector("#editor"),
  layoutMode: document.querySelector("#layout-mode"),
  gridCountLabel: document.querySelector("#grid-count-label"),
  gridCount: document.querySelector("#grid-count"),
  autoCrop: document.querySelector("#auto-crop"),
  autoCropPadding: document.querySelector("#auto-crop-padding"),
  cropLeft: document.querySelector("#crop-left"),
  cropRight: document.querySelector("#crop-right"),
  cropTop: document.querySelector("#crop-top"),
  cropBottom: document.querySelector("#crop-bottom"),
  exportImage: document.querySelector("#export-image"),
  exportPlt: document.querySelector("#export-plt"),
  fitView: document.querySelector("#fit-view")
};

if (typeof window !== "undefined" && document.readyState !== "loading") {
  init();
} else if (typeof window !== "undefined") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
}

function init() {
  bindEvents();
  renderEmptyStage();
  updateControls();
}

function bindEvents() {
  els.file.addEventListener("change", onFilePicked);
  els.layoutMode.addEventListener("input", rerenderLayout);
  els.gridCount.addEventListener("input", rerenderLayout);
  els.autoCrop.addEventListener("input", rerenderLayout);
  els.autoCropPadding.addEventListener("input", rerenderLayout);
  for (const input of [els.cropLeft, els.cropRight, els.cropTop, els.cropBottom]) {
    input.addEventListener("input", rerenderLayout);
  }
  els.exportImage.addEventListener("click", exportLayoutImage);
  els.fitView.addEventListener("click", fitStageToView);
  els.form.addEventListener("submit", (event) => event.preventDefault());

  els.dropzone.addEventListener("dragover", (event) => {
    event.preventDefault();
    els.dropzone.classList.add("is-dragover");
  });
  els.dropzone.addEventListener("dragleave", () => {
    els.dropzone.classList.remove("is-dragover");
  });
  els.dropzone.addEventListener("drop", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    els.dropzone.classList.remove("is-dragover");
    const [file] = event.dataTransfer.files;
    if (file) {
      await loadPdfFile(file);
    }
  });

  document.addEventListener("dragover", (event) => {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
  });

  document.addEventListener("drop", async (event) => {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    els.dropzone.classList.remove("is-dragover");
    const [file] = event.dataTransfer.files;
    if (file) {
      await loadPdfFile(file);
    }
  });

  window.addEventListener("resize", () => {
    resizeStageToEditor();
    fitStageToView({ preserveZoom: true });
  });
}

async function onFilePicked(event) {
  const [file] = event.target.files;
  if (file) {
    await loadPdfFile(file);
  }
}

async function loadPdfFile(file) {
  const token = state.renderToken + 1;
  state.renderToken = token;
  resetPdfState();
  state.file = file;
  renderUploadPrompt();
  setBusy(true);
  setStatus(`正在加载：${file.name}`);
  setMeta("正在解析 PDF 页面...");
  try {
    if (!isPdfFile(file)) {
      throw new Error("请选择 PDF 文件。");
    }
    const buffer = await file.arrayBuffer();
    const loadingTask = pdfjsLib.getDocument({
      data: buffer,
      cMapUrl: "/vendor/pdfjs/cmaps/",
      cMapPacked: true,
      standardFontDataUrl: "/vendor/pdfjs/standard_fonts/",
      wasmUrl: "/vendor/pdfjs/wasm/"
    });
    const pdfDocument = await loadingTask.promise;
    if (token !== state.renderToken) return;
    if (pdfDocument.numPages > MAX_PAGE_COUNT) {
      throw new Error(`PDF 页数过多，当前最多支持 ${MAX_PAGE_COUNT} 页。`);
    }
    state.pdfDocument = pdfDocument;
    setStatus(`已加载：${file.name}`);
    setMeta(`共 ${pdfDocument.numPages} 页，正在渲染预览...`);
    state.pages = await renderPdfPages(pdfDocument, token);
    if (token !== state.renderToken) return;
    rerenderLayout();
    setStatus("PDF 已加载");
    setMeta(formatLoadedMeta());
  } catch (error) {
    if (token !== state.renderToken) return;
    resetPdfState({ keepFile: true });
    setStatus("加载失败");
    setMeta(error instanceof Error ? error.message : String(error));
    renderEmptyStage("无法显示 PDF，请检查文件内容。");
  } finally {
    if (token === state.renderToken) {
      setBusy(false);
    }
  }
}

async function renderPdfPages(pdfDocument, token) {
  const pages = [];
  let renderedPixels = 0;
  for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
    if (token !== state.renderToken) return pages;
    const page = await pdfDocument.getPage(pageNumber);
    const viewport = page.getViewport({ scale: RENDER_SCALE });
    renderedPixels += viewport.width * viewport.height;
    if (renderedPixels > MAX_RENDERED_PIXELS) {
      throw new Error("PDF 页面尺寸过大，请降低页数或使用较小尺寸的文件。");
    }
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const context = canvas.getContext("2d", { alpha: false });
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({
      canvasContext: context,
      viewport,
      canvas
    }).promise;
    pages.push({
      pageNumber,
      canvas,
      contentBounds: detectCanvasContentBounds(canvas),
      widthPx: canvas.width,
      heightPx: canvas.height,
      widthPt: viewport.width / RENDER_SCALE,
      heightPt: viewport.height / RENDER_SCALE
    });
    setMeta(`正在渲染预览... ${pageNumber} / ${pdfDocument.numPages}`);
  }
  return pages;
}

function rerenderLayout() {
  els.gridCountLabel.textContent = els.layoutMode.value === "horizontal" ? "每行个数" : "每列个数";
  if (!state.pages.length) {
    updateControls();
    return;
  }
  const options = readLayoutOptions();
  state.layout = buildPdfLayout(state.pages, options);
  renderStage();
  fitStageToView();
  setMeta(formatLoadedMeta());
  updateControls();
}

function renderStage() {
  ensureStage();
  const layer = state.layer;
  layer.destroyChildren();
  const layout = state.layout;
  if (!layout || !layout.items.length) {
    renderEmptyStage();
    return;
  }

  const background = new Konva.Rect({
    x: 0,
    y: 0,
    width: Math.max(layout.bounds.width, 1),
    height: Math.max(layout.bounds.height, 1),
    fill: "#eef4ff",
    listening: false
  });
  layer.add(background);

  for (const item of layout.items) {
    const group = new Konva.Group({
      x: item.x,
      y: item.y,
      listening: false
    });
    group.add(new Konva.Rect({
      x: -PAGE_SHADOW_MARGIN_PX,
      y: -PAGE_SHADOW_MARGIN_PX,
      width: item.width + PAGE_SHADOW_MARGIN_PX * 2,
      height: item.height + PAGE_SHADOW_MARGIN_PX * 2,
      fill: "#ffffff",
      shadowColor: "rgba(15, 23, 42, 0.16)",
      shadowBlur: 12,
      shadowOffset: { x: 0, y: 3 },
      cornerRadius: 1
    }));
    group.add(new Konva.Image({
      image: item.page.canvas,
      x: 0,
      y: 0,
      width: item.width,
      height: item.height,
      crop: item.crop
    }));
    layer.add(group);
  }
  layer.draw();
}

function ensureStage() {
  if (state.stage) {
    resizeStageToEditor();
    return;
  }
  els.editor.innerHTML = "";
  state.stageWrap = document.createElement("div");
  state.stageWrap.id = "stage";
  state.stageWrap.className = "stage-host";
  els.editor.appendChild(state.stageWrap);
  const rect = getEditorRect();
  state.stage = new Konva.Stage({
    container: state.stageWrap,
    width: rect.width,
    height: rect.height,
    draggable: true
  });
  state.layer = new Konva.Layer();
  state.stage.add(state.layer);
  bindStageZoom();
}

function bindStageZoom() {
  state.stage.on("wheel", (event) => {
    event.evt.preventDefault();
    const stage = state.stage;
    const pointer = stage.getPointerPosition();
    if (!pointer) return;
    const previousScale = stage.scaleX();
    const nextScale = clamp(previousScale * Math.exp(-event.evt.deltaY * 0.001), 0.08, 8);
    const mousePointTo = {
      x: (pointer.x - stage.x()) / previousScale,
      y: (pointer.y - stage.y()) / previousScale
    };
    stage.scale({ x: nextScale, y: nextScale });
    stage.position({
      x: pointer.x - mousePointTo.x * nextScale,
      y: pointer.y - mousePointTo.y * nextScale
    });
  });
}

function fitStageToView(options = {}) {
  if (!state.stage || !state.layout) return;
  const previousSize = {
    width: state.stage.width(),
    height: state.stage.height()
  };
  const rect = getEditorRect();
  resizeStageToEditor();
  const bounds = state.layout.bounds.width && state.layout.bounds.height ? state.layout.bounds : EMPTY_BOUNDS;
  if (options.preserveZoom && state.stage.scaleX() !== 1) {
    const scale = state.stage.scaleX();
    const previousCenter = {
      x: previousSize.width / 2,
      y: previousSize.height / 2
    };
    const contentCenter = {
      x: (previousCenter.x - state.stage.x()) / scale,
      y: (previousCenter.y - state.stage.y()) / scale
    };
    state.stage.position({
      x: (rect.width / 2) - contentCenter.x * scale,
      y: (rect.height / 2) - contentCenter.y * scale
    });
    return;
  }
  const padding = 36;
  const scale = Math.min(
    (rect.width - padding * 2) / Math.max(bounds.width, 1),
    (rect.height - padding * 2) / Math.max(bounds.height, 1),
    1
  );
  const nextScale = clamp(scale, 0.08, 2);
  state.stage.scale({ x: nextScale, y: nextScale });
  state.stage.position({
    x: (rect.width - bounds.width * nextScale) / 2,
    y: Math.max(24, (rect.height - bounds.height * nextScale) / 2)
  });
}

function resizeStageToEditor() {
  if (!state.stage) return;
  const rect = getEditorRect();
  state.stage.size({
    width: rect.width,
    height: rect.height
  });
}

function renderEmptyStage(message = "加载 PDF 文件后，可滚轮缩放、按住拖动预览。") {
  destroyStage();
  els.editor.innerHTML = `<div class="editor-empty">${escapeHtml(message)}</div>`;
}

function exportLayoutImage() {
  if (!state.stage || !state.layout || !state.layout.items.length || state.isRendering) return;
  const options = readLayoutOptions();
  const previous = {
    x: state.stage.x(),
    y: state.stage.y(),
    scaleX: state.stage.scaleX(),
    scaleY: state.stage.scaleY()
  };
  try {
    state.stage.position({ x: 0, y: 0 });
    state.stage.scale({ x: 1, y: 1 });
    state.layer.draw();
    const dataUrl = state.stage.toDataURL({
      x: 0,
      y: 0,
      width: Math.max(state.layout.bounds.width, 1),
      height: Math.max(state.layout.bounds.height, 1),
      pixelRatio: EXPORT_PIXEL_RATIO,
      mimeType: "image/png"
    });
    const suffix = options.autoCrop ? "auto-cropped-layout" : "layout";
    downloadDataUrl(dataUrl, `${stripExtension(state.file?.name ?? "layout")}-${suffix}.png`);
  } finally {
    state.stage.position({ x: previous.x, y: previous.y });
    state.stage.scale({ x: previous.scaleX, y: previous.scaleY });
    state.layer.draw();
  }
}

function readLayoutOptions() {
  return {
    mode: els.layoutMode.value === "vertical" ? "vertical" : "horizontal",
    count: clamp(Math.trunc(Number(els.gridCount.value) || 1), 1, 24),
    cropMm: {
      left: readCropInput(els.cropLeft),
      right: readCropInput(els.cropRight),
      top: readCropInput(els.cropTop),
      bottom: readCropInput(els.cropBottom)
    },
    autoCrop: els.autoCrop.checked,
    autoCropPaddingMm: readCropInput(els.autoCropPadding),
    gapPx: DEFAULT_PAGE_GAP_PX
  };
}

function readCropInput(input) {
  const value = Number(input.value);
  return Number.isFinite(value) ? Math.max(value, 0) : 0;
}

function detectCanvasContentBounds(canvas) {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const { width, height } = canvas;
  const imageData = context.getImageData(0, 0, width, height).data;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * width * 4;
    for (let x = 0; x < width; x += 1) {
      const offset = rowOffset + x * 4;
      const alpha = imageData[offset + 3];
      if (alpha <= CONTENT_ALPHA_THRESHOLD) continue;
      const red = imageData[offset];
      const green = imageData[offset + 1];
      const blue = imageData[offset + 2];
      if (red >= CONTENT_THRESHOLD && green >= CONTENT_THRESHOLD && blue >= CONTENT_THRESHOLD) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }

  if (maxX < minX || maxY < minY) {
    return {
      x: 0,
      y: 0,
      width,
      height,
      isEmpty: true
    };
  }

  return {
    x: minX,
    y: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
    isEmpty: false
  };
}

function setBusy(isBusy) {
  state.isRendering = isBusy;
  updateControls();
}

function updateControls() {
  const hasPages = state.pages.length > 0;
  els.exportImage.disabled = state.isRendering || !hasPages;
  els.fitView.disabled = !hasPages;
  els.exportPlt.disabled = true;
  els.exportPlt.title = "PLT 导出后续支持";
  els.exportImage.classList.toggle("is-loading", state.isRendering);
  els.exportImage.textContent = state.isRendering ? "处理中..." : "导出图片";
}

function renderUploadPrompt() {
  if (state.file) {
    els.dropzoneTitle.textContent = state.file.name;
    els.dropzoneDescription.textContent = "已选择文件，可点击或拖入新文件替换";
    return;
  }
  els.dropzoneTitle.textContent = "把 PDF 文件拖到这里";
  els.dropzoneDescription.textContent = "或者点击选择文件";
}

function resetPdfState(options = {}) {
  state.pdfDocument?.destroy?.();
  state.pdfDocument = null;
  state.pages = [];
  state.layout = null;
  destroyStage();
  if (!options.keepFile) {
    state.file = null;
    els.file.value = "";
    renderUploadPrompt();
  }
  updateControls();
}

function destroyStage() {
  state.stage?.destroy();
  state.stage = null;
  state.layer = null;
  state.stageWrap = null;
}

function formatLoadedMeta() {
  if (!state.file || !state.pages.length || !state.layout) {
    return "拖放 PDF 文件或从磁盘选择一个文件。";
  }
  const pageLabel = `${state.pages.length} 页`;
  const layoutLabel = state.layout.mode === "horizontal"
    ? `横向 · 每行 ${state.layout.count} 个`
    : `纵向 · 每列 ${state.layout.count} 个`;
  const sizeLabel = `${Math.round(state.layout.bounds.width)} × ${Math.round(state.layout.bounds.height)} px`;
  const cropMode = state.layout.autoCrop
    ? ` · 自动裁白边开启，会改变页面尺寸，保留 ${formatNumber(state.layout.autoCropPaddingMm)} mm`
    : " · 保持页面尺寸";
  return `${state.file.name} · ${formatSize(state.file.size)} · ${pageLabel} · ${layoutLabel} · 画布 ${sizeLabel}${cropMode}`;
}

function setStatus(message) {
  els.status.textContent = message;
}

function setMeta(message) {
  els.meta.textContent = message;
}

function getEditorRect() {
  const rect = els.editor.getBoundingClientRect();
  return {
    width: Math.max(Math.round(rect.width), 1),
    height: Math.max(Math.round(rect.height), 1)
  };
}

function isPdfFile(file) {
  return file.type === "application/pdf" || /\.pdf$/i.test(file.name);
}

function hasDraggedFiles(event) {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

function downloadDataUrl(dataUrl, filename) {
  const link = document.createElement("a");
  link.href = dataUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function stripExtension(name) {
  return name.replace(/\.[^.]+$/, "");
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatNumber(value) {
  return Number(value).toFixed(2).replace(/\.?0+$/, "");
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
