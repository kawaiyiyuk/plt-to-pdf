const els = {
  title: document.querySelector("#title"),
  status: document.querySelector("#status"),
  meta: document.querySelector("#meta"),
  jobId: document.querySelector("#job-id"),
  credits: document.querySelector("#credits"),
  download: document.querySelector("#download")
};

const params = new URLSearchParams(window.location.search);
const jobId = params.get("jobId")?.trim();
const clientId = params.get("clientId")?.trim() || getClientId();

let currentRequestId = 0;

init();

function init() {
  if (!jobId) {
    renderError("缺少 jobId，请返回重新提交。");
    return;
  }

  els.jobId.textContent = jobId;
  renderCredits(null);
  renderStatus("任务已提交，正在读取队列状态...");
  pollJob();
}

async function pollJob() {
  const requestId = currentRequestId + 1;
  currentRequestId = requestId;
  while (currentRequestId === requestId) {
    try {
      const job = await fetchJson(`/api/jobs/${encodeURIComponent(jobId)}`);
      if (currentRequestId !== requestId) return;
      renderJob(job);
      await loadBalance();
      if (job.status === "done" || job.status === "error") {
        return;
      }
      await sleep(1000);
    } catch (error) {
      await loadBalance();
      renderError(error instanceof Error ? error.message : String(error));
      return;
    }
  }
}

async function loadBalance() {
  try {
    const credits = await fetchJson(`/api/credits/${encodeURIComponent(clientId)}`);
    renderCredits(credits);
  } catch {
    renderCredits(null);
  }
}

function renderJob(job) {
  const queueInfo = job.status === "queued"
    ? (job.aheadCount > 0
      ? `前面还有 ${job.aheadCount} 个任务`
      : "正在排队")
    : job.status === "running"
      ? "服务器正在生成 PDF"
      : job.status === "done"
        ? "PDF 已生成"
        : "转换失败";

  els.title.textContent = queueTitle(job.status);
  els.status.textContent = queueInfo;
  els.meta.textContent = job.status === "queued" || job.status === "running"
    ? `队列中 ${job.pending} 个任务 · 当前 ${job.active} 个正在处理`
    : job.status === "done"
      ? formatLayoutSummary(job.layout)
      : job.error || "任务失败";
  if (job.status === "done") {
    renderDownload(job);
  }
}

function renderDownload(job) {
  const blob = pdfResultToBlob(job);
  const url = URL.createObjectURL(blob);
  els.download.hidden = false;
  els.download.href = url;
  els.download.download = "output.pdf";
  els.download.textContent = "下载 PDF";
  els.status.textContent = "转换完成，可以下载文件。";
}

function renderCredits(credits) {
  if (!credits) {
    els.credits.textContent = "未知";
    return;
  }
  els.credits.textContent = `${credits.availableBalance} 可用 / ${credits.reservedBalance} 冻结 / ${credits.spentBalance} 已消耗`;
}

function renderStatus(message) {
  els.status.textContent = message;
}

function renderError(message) {
  els.title.textContent = "无法加载任务";
  els.status.textContent = message;
  els.meta.textContent = "请返回首页重新提交。";
  els.download.hidden = true;
}

function queueTitle(status) {
  if (status === "queued") return "正在排队";
  if (status === "running") return "正在生成";
  if (status === "done") return "已完成";
  return "转换失败";
}

function formatLayoutSummary(layout) {
  if (!layout) return "任务已完成";
  const size = layout.drawingWidthMm && layout.drawingHeightMm
    ? `图形 ${layout.drawingWidthMm.toFixed(0)} × ${layout.drawingHeightMm.toFixed(0)} mm · `
    : "";
  if (layout.type !== "tiled") {
    return `${size}单页输出`;
  }
  return `${size}${layout.paperSize} ${layout.orientation === "landscape" ? "横向" : "竖向"} · ${layout.columns} × ${layout.rows} 页`;
}

function pdfResultToBlob(result) {
  if (typeof result?.pdfBase64 !== "string") {
    throw new Error("任务结果缺少 PDF 数据");
  }
  const bytes = Uint8Array.from(atob(result.pdfBase64), (char) => char.charCodeAt(0));
  return new Blob([bytes], { type: "application/pdf" });
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(result.error || `请求失败: ${response.status}`);
  }
  return result;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getClientId() {
  const storageKey = "plt-to-pdf:client-id";
  let value = localStorage.getItem(storageKey);
  if (!value) {
    value = crypto.randomUUID();
    localStorage.setItem(storageKey, value);
  }
  return value;
}
