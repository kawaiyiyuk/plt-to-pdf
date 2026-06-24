import { createServer } from "node:http";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { convertPltBufferWithHp2xx, previewPltBufferWithHp2xx } from "./server/hp2xx-converter.js";
import { ConversionQueue, QueueFullError } from "./server/conversion-queue.js";
import { ConversionJobStore } from "./server/conversion-job-store.js";
import { UploadTooLargeError } from "./server/http-errors.js";

const root = resolve(".");
const port = Number(process.env.PORT ?? 4173);
const host = "127.0.0.1";
const maxUploadMb = Number(process.env.MAX_UPLOAD_MB ?? 20);
const maxUploadBytes = Math.max(1, maxUploadMb) * 1024 * 1024;
const maxJsonUploadBytes = getMaxJsonUploadBytes(maxUploadBytes);
const convertTimeoutMs = Number(process.env.CONVERT_TIMEOUT_MS ?? 30000);
const convertQueue = new ConversionQueue({
  concurrency: Number(process.env.CONVERT_CONCURRENCY ?? 1),
  queueLimit: Number(process.env.CONVERT_QUEUE_LIMIT ?? 20)
});
const convertJobs = new ConversionJobStore({ queue: convertQueue });

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".pdf": "application/pdf",
  ".bcmap": "application/octet-stream",
  ".wasm": "application/wasm",
  ".cff": "font/collection",
  ".pfb": "application/octet-stream",
  ".ttf": "font/ttf"
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "POST" && url.pathname === "/api/convert") {
      await handleConvert(req, res);
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/jobs/")) {
      await handleJobStatus(req, res, decodeURIComponent(url.pathname.slice("/api/jobs/".length)));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/preview") {
      await handlePreview(req, res);
      return;
    }

    const staticFile = resolveStaticFile(url.pathname);
    if (!staticFile) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
    const data = await readFile(staticFile.filePath);
    res.writeHead(200, {
      "Content-Type": mimeTypes[extname(staticFile.filePath)] ?? "application/octet-stream",
      "Cache-Control": "no-store"
    });
    res.end(data);
  } catch (error) {
    if (!res.headersSent) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
    } else {
      res.end();
    }
  }
});

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  server.listen(port, host, () => {
    console.log(`http://${host}:${port}`);
  });
}

async function handleConvert(req, res) {
  try {
    const { payload, source } = await readConvertPayload(req);
    const submitted = convertJobs.enqueue("convert", () => convertPltBufferWithHp2xx(source, {
      paperSize: payload.paperSize || null,
      orientation: payload.orientation || "auto",
      marginPt: Number(payload.marginPt ?? 0),
      lineWidthMm: Number(payload.lineWidthMm),
      unitsPerInch: Number(payload.unitsPerInch ?? 1016),
      timeoutMs: convertTimeoutMs
    }));
    const snapshot = convertJobs.get(submitted.jobId) ?? submitted.snapshot;
    res.writeHead(snapshot?.status === "done" ? 200 : 202, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    });
    res.end(JSON.stringify(snapshot));
  } catch (error) {
    const statusCode = getErrorStatusCode(error);
    res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({
      error: error instanceof Error ? error.message : String(error)
    }));
  }
}

async function handlePreview(req, res) {
  try {
    const { payload, source } = await readConvertPayload(req);
    const { svg, layout } = await convertQueue.run(() => previewPltBufferWithHp2xx(source, {
      paperSize: payload.paperSize || null,
      orientation: payload.orientation || "auto",
      marginPt: Number(payload.marginPt ?? 0),
      lineWidthMm: Number(payload.lineWidthMm),
      unitsPerInch: Number(payload.unitsPerInch ?? 1016),
      timeoutMs: convertTimeoutMs
    }));
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8"
    });
    res.end(JSON.stringify({
      svgBase64: Buffer.from(svg, "utf8").toString("base64"),
      layout
    }));
  } catch (error) {
    const statusCode = getErrorStatusCode(error);
    res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({
      error: error instanceof Error ? error.message : String(error)
    }));
  }
}

async function handleJobStatus(_req, res, jobId) {
  try {
    const snapshot = convertJobs.get(jobId);
    if (!snapshot) {
      res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "任务不存在或已过期" }));
      return;
    }
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    });
    res.end(JSON.stringify(snapshot));
  } catch (error) {
    const statusCode = getErrorStatusCode(error);
    res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({
      error: error instanceof Error ? error.message : String(error)
    }));
  }
}

async function readConvertPayload(req) {
  const body = await readRequestBody(req, maxJsonUploadBytes);
  const payload = JSON.parse(body.toString("utf8"));
  const source = payload.sourceBase64
    ? Buffer.from(payload.sourceBase64, "base64")
    : Buffer.from(payload.source ?? "", "utf8");
  if (source.byteLength > maxUploadBytes) {
    throw new UploadTooLargeError(maxUploadMb);
  }
  return { payload, source };
}

function readRequestBody(req, maxBytes) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    let total = 0;
    let rejected = false;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        chunks.length = 0;
        if (!rejected) {
          rejected = true;
          reject(new UploadTooLargeError(maxUploadMb));
        }
        return;
      }
      if (!rejected) {
        chunks.push(chunk);
      }
    });
    req.on("end", () => {
      if (!rejected) {
        resolvePromise(Buffer.concat(chunks));
      }
    });
    req.on("error", (error) => {
      if (!rejected) {
        reject(error);
      }
    });
  });
}

function getErrorStatusCode(error) {
  if (error instanceof QueueFullError) {
    return error.statusCode;
  }
  if (Number.isInteger(error?.statusCode)) {
    return error.statusCode;
  }
  return 500;
}

export function getMaxJsonUploadBytes(maxDecodedBytes) {
  return Math.ceil(maxDecodedBytes * 4 / 3) + 1024;
}

export function resolveStaticFile(pathname) {
  const vendorFile = resolveVendorFile(pathname);
  if (vendorFile) {
    return { filePath: vendorFile };
  }
  const normalizedPathname = pathname === "/" ? "/index.html" : pathname;
  if (normalizedPathname === "/node_modules" || normalizedPathname.startsWith("/node_modules/")) {
    return null;
  }
  const filePath = resolve(join(root, normalizedPathname.slice(1)));
  if (!isPathInsideRoot(filePath)) {
    return null;
  }
  return { filePath };
}

export function resolveVendorFile(pathname) {
  const exactVendorFiles = {
    "/vendor/konva/konva.min.js": "node_modules/konva/konva.min.js",
    "/vendor/pdfjs/pdf.mjs": "node_modules/pdfjs-dist/build/pdf.mjs",
    "/vendor/pdfjs/pdf.worker.mjs": "node_modules/pdfjs-dist/build/pdf.worker.mjs"
  };
  if (exactVendorFiles[pathname]) {
    return resolve(exactVendorFiles[pathname]);
  }

  const vendorDirectories = [
    ["/vendor/pdfjs/cmaps/", "node_modules/pdfjs-dist/cmaps"],
    ["/vendor/pdfjs/standard_fonts/", "node_modules/pdfjs-dist/standard_fonts"],
    ["/vendor/pdfjs/wasm/", "node_modules/pdfjs-dist/wasm"]
  ];
  for (const [urlPrefix, directory] of vendorDirectories) {
    if (!pathname.startsWith(urlPrefix)) continue;
    const filename = pathname.slice(urlPrefix.length);
    if (!filename || filename.includes("/") || filename.includes("\\")) {
      return null;
    }
    const filePath = resolve(join(directory, filename));
    if (!isPathInsideDirectory(filePath, resolve(directory))) {
      return null;
    }
    return filePath;
  }

  return null;
}

function isPathInsideRoot(filePath) {
  return isPathInsideDirectory(filePath, root);
}

function isPathInsideDirectory(filePath, directory) {
  const relativePath = relative(directory, filePath);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}
